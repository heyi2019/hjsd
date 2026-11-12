"""reporting.profit：订单利润明细（RPT-01）。

利润口径（2026-11-05 用户裁决）：**该订单所有收入 − 所有支出**，
可正可负可 0；与分润基数同源，取数统一走 `cashflow_totals_by_order`。
资金走向只有收入 / 支出两种，不以「是否生成资金流水」为界：
收入 = 资金流水 IN + 返点记录金额；支出 = 资金流水 OUT + 分期坏账金额。
收入大类 = 售出价 + 返点 + 其他收入子类型；支出大类 = 提号价/回收价（买入成本）
+ 直接费用 + 分期坏账 + 其他支出子类型。收入/买入成本/直接费用三列是两个大类的
分解；返点列是「其中返点收入」展示项、已含在收入大类，不重复计入净利。
作废（VOID）返点不是收入，随收入大类一起排除，与售出价 CANCEL 冲销同规则。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any
from app.core.security import CurrentUser
from app.parties.fields import get_extra_values_bulk
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from app.domain.enums import RebateStatus
from app.domain.trade import (
    Order,
    RebateRecord,
)

from app.core.money import to_money_or_zero
from ._shared import (
    ZERO,
    _apply_order_scope,
    _sum_report_field,
    _validate_date_range,
    cashflow_totals_by_order,
)

def order_profit_detail(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """订单利润明细：合计与 R5 对应维度一致，可导出但不改原始数据。

    订单范围先按权限过滤，再一次性按订单汇总资金流水，避免逐单查询。
    """
    _validate_date_range(from_date, to_date)
    orders_stmt = _apply_order_scope(
        select(
            Order.id.label("id"),
            Order.order_no.label("order_no"),
            Order.order_type.label("order_type"),
            Order.trade_date.label("trade_date"),
            Order.status.label("status"),
        ),
        user,
        session,
    )
    orders = session.execute(orders_stmt).all()
    order_ids = [row.id for row in orders]
    extra_values = get_extra_values_bulk(
        session, entity_type="order", entity_ids=order_ids
    )
    cashflow_by_order = cashflow_totals_by_order(session, order_ids=order_ids)
    # 返点收益列 = 该订单返点记录金额合计，与收入列里的返点部分是同一笔钱。
    rebate_by_order: dict[int, Decimal] = defaultdict(lambda: ZERO)
    if order_ids:
        rebate_rows = session.execute(
            select(
                RebateRecord.source_order_id,
                func.coalesce(func.sum(RebateRecord.base_amount), 0),
            )
            .where(RebateRecord.source_order_id.in_(order_ids))
            .where(RebateRecord.status != RebateStatus.VOID.value)
            .group_by(RebateRecord.source_order_id)
        )
        for source_order_id, amount in rebate_rows:
            rebate_by_order[int(source_order_id)] = to_money_or_zero(amount)
    no_totals = (ZERO, ZERO, ZERO)
    items = []
    for order in orders:
        if from_date and order.trade_date < from_date:
            continue
        if to_date and order.trade_date > to_date:
            continue
        income, expense, buy_amount = cashflow_by_order.get(order.id, no_totals)
        rebate = rebate_by_order.get(order.id, ZERO)
        items.append(
            {
                "order_no": order.order_no,
                "order_id": order.id,
                "order_type": order.order_type,
                "trade_date": order.trade_date.isoformat(),
                "status": order.status,
                "income": income,
                "buy_amount": buy_amount,
                "direct_cost": expense - buy_amount,
                # 返点收入已计入上面的 income，此处只作其中项展示，不重复加进净利。
                "rebate": rebate,
                "net_profit": income - expense,
                "extra_values": extra_values.get(order.id, {}),
            }
        )
    return {
        "items": items,
        "total": {
            "income": _sum_report_field(items, "income"),
            "buy_amount": _sum_report_field(items, "buy_amount"),
            "direct_cost": _sum_report_field(items, "direct_cost"),
            "rebate": _sum_report_field(items, "rebate"),
            "net_profit": _sum_report_field(items, "net_profit"),
        },
    }
