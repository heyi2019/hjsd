"""分润对账（应付 / 已付 / 差异）。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any
from app.core.security import CurrentUser
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.domain.enums import EventType, OrderStatus
from app.domain.trade import (
    Account,
    Order,
    OrderEvent,
    OrderProfitAllocation,
)

from app.core.money import to_money_or_zero
from ._shared import (
    ZERO,
    _apply_order_scope,
    _validate_date_range,
    cashflow_totals_by_order,
)

def r3_commission_reconciliation(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None, mine: bool = False, all_people: bool = False,
    user_id: int | None = None,
) -> dict[str, Any]:
    """分润对账：按订单汇总，展开订单查看人员明细。"""
    _validate_date_range(from_date, to_date)
    order_scope = None if all_people else user
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
            order_scope,
            session,
        )
    ).all()
    if mine and user is not None:
        rows = [row for row in rows if row[0].user_id == user.id]
    if user_id is not None:
        rows = [row for row in rows if row[0].user_id == user_id]

    order_ids = {order.id for _, order in rows}
    account_ids = {order.account_id for _, order in rows if order.account_id is not None}
    accounts = {
        account.id: account
        for account in session.scalars(select(Account).where(Account.id.in_(account_ids))).all()
    } if account_ids else {}
    outbound_dates: dict[int, date] = {}
    if order_ids:
        for order_id, occurred_on in session.execute(
            select(OrderEvent.order_id, OrderEvent.occurred_on)
            .where(
                OrderEvent.order_id.in_(order_ids),
                OrderEvent.event_type == EventType.SELL.value,
            )
            .order_by(OrderEvent.order_id, OrderEvent.occurred_on)
        ).all():
            outbound_dates.setdefault(order_id, occurred_on)

    # 利润 = 该订单所有收入 − 所有支出（2026-11-05 用户裁决）。
    # 走报表唯一取数口，与分润弹窗同源：收入含返点记录、支出含分期坏账；
    # 不再由 SELL/BUY 事件单独推导，也不按「是否生成流水」排除有资金走向的事实。
    per_order_profit: dict[int, Decimal] = defaultdict(lambda: ZERO)
    scoped_order_ids = {order.id for _, order in rows}
    if scoped_order_ids:
        for order_id, (income, expense, _buy) in cashflow_totals_by_order(
            session, order_ids=scoped_order_ids
        ).items():
            per_order_profit[order_id] = to_money_or_zero(income - expense)

    order_grouped: dict[int, dict[str, Any]] = {}
    for allocation, order in rows:
        if from_date and order.trade_date < from_date:
            continue
        if to_date and order.trade_date > to_date:
            continue
        profit = per_order_profit[order.id]
        rate = to_money_or_zero(allocation.allocation_rate)
        amount = to_money_or_zero(allocation.allocation_amount)
        account = accounts.get(order.account_id)
        # 分润支持「按比例」与「按金额」两种录入口径：填了金额就直接作为应付基数，
        # 否则按 利润 × 比例 计算。二者由录入校验保证不会同时出现。
        # 判据必须是 `!= 0` 而非 `> 0`：亏损单的金额本身就是负数（填 -300 表示分担 300 亏损），
        # 用 `> 0` 会把负数误判成「没填金额」而回退到比例，亏损分润就算错。
        base = (
            amount
            if amount != 0
            else (profit * rate / Decimal("100")).quantize(Decimal("0.01"))
        )
        detail = {
            "user_id": allocation.user_id,
            "order_no": order.order_no,
            "order_id": order.id,
            "inventory_date": account.inventory_entry_at.date() if account else None,
            "outbound_date": outbound_dates.get(order.id),
            "allocation_type": allocation.allocation_type,
            "profit_base": base,
            "rate": allocation.allocation_rate,
        }
        group = order_grouped.setdefault(
            order.id,
            {
                "order_id": order.id,
                "order_no": order.order_no,
                "inventory_date": detail["inventory_date"],
                "outbound_date": detail["outbound_date"],
                "profit_base": ZERO,
                "orders": [],
            },
        )
        group["profit_base"] += base
        group["orders"].append(detail)

    order_groups = [
        order_grouped[order_id]
        for order_id in sorted(order_grouped)
    ]
    total_profit_base = sum(
        (group["profit_base"] for group in order_groups),
        ZERO,
    )
    return {
        "order_groups": order_groups,
        "total": {
            "order_count": len(order_groups),
            "profit_base": total_profit_base,
            "payable": ZERO,
            "paid": ZERO,
            "difference": ZERO,
        },
    }


# --------------------------------------------------------------------- 业务损益
