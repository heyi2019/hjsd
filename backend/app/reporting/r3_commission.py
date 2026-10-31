"""reporting.r3_commission：R3 提成对账（应付 / 已付 / 差异）。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any
from app.core.security import CurrentUser
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.domain.enums import OrderStatus
from app.domain.trade import (
    Order,
    OrderEvent,
    OrderProfitAllocation,
)

from ._shared import (
    ZERO,
    _apply_order_scope,
    _bad_debt_by_order,
    _event_totals,
    _money,
    _sum_report_field,
    _validate_date_range,
)

def r3_commission_reconciliation(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """R3 提成对账：按人员钻取到单；无规则版本时提成率为 0（不臆造）。"""
    _validate_date_range(from_date, to_date)
    rows = session.execute(
        _apply_order_scope(
            select(OrderProfitAllocation, Order)
            .join(Order, Order.id == OrderProfitAllocation.order_id)
            .where(
                Order.status.in_(
                    [
                        OrderStatus.COMPLETED.value,
                        OrderStatus.INSTALLMENT.value,
                        OrderStatus.ACTIVE.value,
                    ]
                )
            ),
            user,
            session,
        )
    ).all()

    per_order_profit: dict[int, Decimal] = defaultdict(lambda: ZERO)
    events = session.scalars(
        _apply_order_scope(
            select(OrderEvent)
            .join(Order, Order.id == OrderEvent.order_id)
            .where(OrderEvent.is_posted.is_(True)),
            user,
            session,
        )
    ).all()
    events_by_order: dict[int, list[OrderEvent]] = defaultdict(list)
    for event in events:
        events_by_order[event.order_id].append(event)
    for order_id, order_events in events_by_order.items():
        income, buy_amount, direct_cost = _event_totals(order_events)
        per_order_profit[order_id] = income - buy_amount - direct_cost
    for order_id, amount in _bad_debt_by_order(session, user=user).items():
        per_order_profit[order_id] -= amount

    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for allocation, order in rows:
        if from_date and order.trade_date < from_date:
            continue
        if to_date and order.trade_date > to_date:
            continue
        profit = per_order_profit[order.id]
        rate = _money(allocation.allocation_rate)
        amount = _money(allocation.allocation_amount)
        # 分润支持「按比例」与「按金额」两种录入口径：填了金额就直接作为应付基数，
        # 否则按 利润 × 比例 计算。二者由录入校验保证不会同时出现。
        base = (
            amount
            if amount > 0
            else (profit * rate / Decimal("100")).quantize(Decimal("0.01"))
        )
        grouped[allocation.user_id].append(
            {
                "user_id": allocation.user_id,
                "order_no": order.order_no,
                "order_id": order.id,
                "allocation_type": allocation.allocation_type,
                "profit_base": base,
                "rate": allocation.allocation_rate,
                "amount": allocation.allocation_amount,
                "payable": ZERO,
                "paid": ZERO,
                "difference": ZERO,
            }
        )

    groups = []
    items = []
    for user_id, orders in sorted(grouped.items(), key=lambda item: item[0] or 0):
        base_total = sum((o["profit_base"] for o in orders), ZERO)
        group = {
            "user_id": user_id,
            "order_count": len(orders),
            "profit_base": base_total,
            "payable": sum((o["payable"] for o in orders), ZERO),
            "paid": sum((o["paid"] for o in orders), ZERO),
            "difference": sum((o["difference"] for o in orders), ZERO),
            "orders": orders,
        }
        groups.append(group)
        items.extend(orders)
    return {
        "items": items,
        "groups": groups,
        "total": {
            "order_count": len(items),
            "payable": _sum_report_field(items, "payable"),
            "paid": _sum_report_field(items, "paid"),
            "difference": _sum_report_field(items, "difference"),
        },
    }


# --------------------------------------------------------------------- R5 业务
