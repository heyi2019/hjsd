"""reporting.r5_business_pnl：R5 业务级损益。

主营利润口径（2026-11-05 用户裁决）：按业务类型汇总各订单
「所有收入 − 所有支出」，与订单利润明细 / 分润基数同源。
资金走向只有收入 / 支出两种：返点记录计入收入、分期坏账计入支出，
两者即使不生成资金流水也进主营利润；结算 / 未归集返点列是历史口径的
展示项，不再重复加回完整收益。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any
from app.core.security import CurrentUser
from app.core.security import owner_scope_filter
from app.foundation.classification import classification_for_order_type
from sqlalchemy import (
    and_,
    case,
    func,
    select,
)
from sqlalchemy.orm import Session
from app.domain.trade import (
    Order,
    RebateRecord,
    RebateSettlement,
)

from ._shared import (
    ZERO,
    _apply_order_scope,
    _money,
    _sum_report_field,
    _validate_date_range,
    cashflow_totals_by_order,
)

def r5_business_pnl(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """R5 业务级损益：先按权限取订单，再一次性按订单汇总资金明细收支差。"""
    _validate_date_range(from_date, to_date)
    orders_stmt = _apply_order_scope(
        select(Order.id, Order.order_type), user, session
    )
    order_rows = session.execute(orders_stmt).all()
    cashflow_by_order = cashflow_totals_by_order(
        session,
        order_ids=[row[0] for row in order_rows],
        from_date=from_date,
        to_date=to_date,
    )

    revenue: dict[str, Decimal] = defaultdict(lambda: ZERO)
    cost: dict[str, Decimal] = defaultdict(lambda: ZERO)
    no_totals = (ZERO, ZERO, ZERO)
    for order_id, order_type in order_rows:
        income, expense, _buy = cashflow_by_order.get(order_id, no_totals)
        revenue[order_type] += income
        cost[order_type] += expense

    settled: dict[str, Decimal] = defaultdict(lambda: ZERO)
    unsettled: dict[str, Decimal] = defaultdict(lambda: ZERO)
    # 分次结算按返点记录聚合：冲销（reversal_of_id 非空）取负号；日期过滤
    # 放进外连接 ON 条件——范围外的结算视同不存在。
    settlement_join = [RebateSettlement.rebate_record_id == RebateRecord.id]
    if from_date is not None:
        settlement_join.append(RebateSettlement.settled_on >= from_date)
    if to_date is not None:
        settlement_join.append(RebateSettlement.settled_on <= to_date)
    rebate_stmt = (
        select(
            RebateRecord.id,
            RebateRecord.base_amount,
            RebateRecord.rate,
            Order.order_type,
            func.coalesce(
                func.sum(
                    case(
                        (RebateSettlement.reversal_of_id.isnot(None), -RebateSettlement.gross_amount),
                        else_=RebateSettlement.gross_amount,
                    )
                ),
                0,
            ).label("settled_gross"),
            func.coalesce(
                func.sum(
                    case(
                        (RebateSettlement.reversal_of_id.isnot(None), -RebateSettlement.platform_fee),
                        else_=RebateSettlement.platform_fee,
                    )
                ),
                0,
            ).label("settled_fee"),
        )
        .outerjoin(RebateSettlement, and_(*settlement_join))
        .join(Order, Order.id == RebateRecord.source_order_id)
        .group_by(RebateRecord.id, Order.order_type)
    )
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            rebate_stmt = rebate_stmt.where(
                scope,
            )
    for _record_id, base_amount, rate, order_type, settled_gross, _settled_fee in (
        session.execute(rebate_stmt).all()
    ):
        bucket = order_type
        settled_gross = _money(settled_gross)
        settled[bucket] += settled_gross
        expected = (
            _money(base_amount) * _money(rate) / Decimal("100")
        ).quantize(Decimal("0.01"))
        # 分次结算只减少剩余未归集金额；没有结算记录时即为全部应收返点。
        unsettled[bucket] += max(ZERO, expected - settled_gross)

    items = []
    for order_type in sorted(set(revenue) | set(cost) | set(settled) | set(unsettled)):
        income = revenue[order_type]
        direct = cost[order_type]
        gross_profit = income - direct
        classification = classification_for_order_type(order_type) or {
            "business_mode": None,
            "business_type": None,
            "value_added_service": None,
        }
        items.append(
            {
                "order_type": order_type,
                **classification,
                "main_income": income,
                "main_cost": direct,
                "main_profit": gross_profit,
                "settled_rebate": settled[order_type],
                "uncollected_rebate": unsettled[order_type],
                # 返点收入已计入 main_income / main_profit，此处不重复加回。
                "full_income": gross_profit,
            }
        )
    return {
        "items": items,
        "total": {
            "main_income": _sum_report_field(items, "main_income"),
            "main_cost": _sum_report_field(items, "main_cost"),
            "main_profit": _sum_report_field(items, "main_profit"),
            "settled_rebate": _sum_report_field(items, "settled_rebate"),
            "uncollected_rebate": _sum_report_field(items, "uncollected_rebate"),
            "full_income": _sum_report_field(items, "full_income"),
        },
    }


# --------------------------------------------------------------------- 资金日报
