"""reporting.r5_business_pnl：R5 业务级损益。

未归集返点**独立成列，不摊给业务**。
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
    OrderEvent,
    RebateRecord,
    RebateSettlement,
)

from ._shared import (
    ZERO,
    _apply_order_scope,
    _bad_debt_rows,
    _event_gain_cases,
    _event_offset_join,
    _money,
    _sum_report_field,
    _validate_date_range,
)

def r5_business_pnl(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """R5 业务级损益：未归集返点独立列，不摊给业务。

    2026-10-28 性能改造：损益事件按「订单×业务」在 SQL 端条件求和（仍按单
    聚合后再归业务，保证 order_types 语义不变），返点结算改为列级查询 +
    条件求和；不再把全部订单×事件 ORM 水合进内存。返回口径与旧实现一致。
    """
    _validate_date_range(from_date, to_date)
    offset, (income_case, buy_case, cost_case) = _event_gain_cases(OrderEvent.amount)
    event_agg = (
        select(
            Order.id.label("order_id"),
            Order.order_type,
            func.coalesce(func.sum(income_case), 0).label("income"),
            func.coalesce(func.sum(buy_case), 0).label("buy_amount"),
            func.coalesce(func.sum(cost_case), 0).label("direct_cost"),
        )
        .join(OrderEvent, OrderEvent.order_id == Order.id)
        .outerjoin(offset, _event_offset_join(offset))
        .where(OrderEvent.is_posted.is_(True))
        .group_by(Order.id, Order.order_type)
    )
    if from_date is not None:
        event_agg = event_agg.where(OrderEvent.occurred_on >= from_date)
    if to_date is not None:
        event_agg = event_agg.where(OrderEvent.occurred_on <= to_date)
    event_agg = _apply_order_scope(event_agg, user, session)

    revenue: dict[str, Decimal] = defaultdict(lambda: ZERO)
    cost: dict[str, Decimal] = defaultdict(lambda: ZERO)
    order_types: dict[int, str] = {}
    for order_id, order_type, income, buy_amount, direct_cost in session.execute(
        event_agg
    ).all():
        revenue[order_type] += _money(income)
        cost[order_type] += _money(buy_amount) + _money(direct_cost)
        order_types[order_id] = order_type

    for order_id, amount, occurred_on in _bad_debt_rows(session, user=user):
        if from_date and occurred_on < from_date:
            continue
        if to_date and occurred_on > to_date:
            continue
        order_type = order_types.get(order_id)
        if order_type is not None:
            cost[order_type] += amount

    settled: dict[str, Decimal] = defaultdict(lambda: ZERO)
    unsettled: dict[str, Decimal] = defaultdict(lambda: ZERO)
    # 分次结算按返点记录聚合：冲销（reversal_of_id 非空）取负号；日期过滤
    # 放进外连接 ON 条件——范围外的结算视同不存在，与旧 Python 过滤一致。
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
    for _record_id, base_amount, rate, order_type, settled_gross, settled_fee in (
        session.execute(rebate_stmt).all()
    ):
        bucket = order_type
        settled_gross = _money(settled_gross)
        settled[bucket] += settled_gross
        cost[bucket] += _money(settled_fee)
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
                "full_income": gross_profit + settled[order_type],
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
