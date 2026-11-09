"""reporting.r1_inventory：R1 库存健康度。

所有已经进入独立库存且仍在库的账号都纳入统计，包括提号账号。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any
from app.core.security import CurrentUser
from app.parties import service as parties_service
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.domain.enums import (
    InventoryStatus,
    OrderStatus,
)
from app.domain.trade import (
    Account,
    Order,
    OrderEvent,
)

from ._shared import (
    ZERO,
    _apply_order_scope,
    _event_totals,
    _money,
)

def r1_inventory_health(
    session: Session, *, user: CurrentUser | None = None
) -> dict[str, Any]:
    """R1 库存健康表：统计独立库存状态为在库的回收/代挂账号。"""
    today = date.today()

    order_cost: dict[int, Decimal] = defaultdict(lambda: ZERO)
    order_income: dict[int, Decimal] = defaultdict(lambda: ZERO)
    event_rows = session.scalars(
        _apply_order_scope(
            select(OrderEvent)
            .join(Order, Order.id == OrderEvent.order_id)
            .where(
                OrderEvent.is_posted.is_(True),
                Order.status == OrderStatus.ACTIVE.value,
            ),
            user,
            session,
        )
    ).all()
    events_by_order: dict[int, list[OrderEvent]] = defaultdict(list)
    for event in event_rows:
        events_by_order[event.order_id].append(event)
    for order_id, events in events_by_order.items():
        income, buy_amount, direct_cost = _event_totals(events)
        order_income[order_id] = income
        order_cost[order_id] = buy_amount + direct_cost

    active_stmt = select(Order).where(Order.status == OrderStatus.ACTIVE.value)
    active_stmt = _apply_order_scope(active_stmt, user, session)
    active = session.scalars(active_stmt).all()
    order_by_account: dict[int, list[Order]] = defaultdict(list)
    for order in active:
        if order.account_id is not None:
            order_by_account[order.account_id].append(order)

    items = []
    account_stmt = select(Account).where(
        Account.inventory_status == InventoryStatus.IN_STOCK.value
    )
    if user is not None and not user.is_admin and user.owner_scope != "ALL":
        visible_order_ids = select(Order.account_id).where(Order.account_id.is_not(None))
        visible_order_ids = _apply_order_scope(visible_order_ids, user, session)
        account_stmt = account_stmt.where(
            (Account.created_by == user.username) | Account.id.in_(visible_order_ids)
        )
    accounts = session.scalars(account_stmt).all()
    account_extra_values = parties_service.get_extra_values_bulk(
        session,
        entity_type="account",
        entity_ids=[account.id for account in accounts],
    )
    for account in accounts:
        orders = order_by_account.get(account.id, [])
        holding_days = (
            (today - account.inventory_entry_at.date()).days
            if account.inventory_entry_at else None
        )
        expected_price = ZERO
        for order in orders:
            expected_price += order_income[order.id]
        buy_amount = _money(account.cost_amount)
        extra_cost = max(
            ZERO, sum((order_cost[o.id] for o in orders), ZERO) - buy_amount
        )
        occupied_cost = buy_amount + extra_cost
        items.append(
            {
                "account_id": account.id,
                "game_account": account.game_account,
                "platform": account.platform,
                "business": ",".join({o.order_type for o in orders}) or None,
                "status": account.inventory_status,
                "buy_amount": buy_amount,
                "extra_cost": extra_cost,
                "total_cost": occupied_cost,
                "holding_days": holding_days,
                "expected_price": expected_price,
                "expected_profit": expected_price - occupied_cost,
                "owner_id": orders[0].owner_id if orders else None,
                "extra_values": account_extra_values.get(account.id, {}),
            }
        )
    return {
        "generated_on": today.isoformat(),
        "items": items,
        "total": len(items),
        "total_cost": sum((item["total_cost"] for item in items), ZERO),
    }


# --------------------------------------------------------------------- R2 月度
