"""按通知页批量构造当前用户可见的分润详情。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.business.order_detail.view.assembler import build_order_outputs
from app.business.order_detail.view.derived import build_detail_view
from app.business.order_detail.view.events import load_event_context
from app.business.router_outputs._shared import _sale_amount
from app.business.router_outputs.list_payload import _order_list_payload
from app.business.stocks._common import scope_filter as account_scope_filter
from app.core.security import CurrentUser
from app.domain.notifications import Notification
from app.domain.trade import Account, Order
from app.domain.users import User
from app.shared.scope import owner_scope_filter
from app.funds.profit_allocation.terms import allocatable_profit_for, company_rate_for_order
from .schemas import ProfitNotificationDetailOut


def profit_details_for_notifications(
    db: Session, notifications: list[Notification], user: CurrentUser,
) -> list[ProfitNotificationDetailOut]:
    if not notifications:
        return []
    stmt = select(Order, Account).join(Account, Account.id == Order.account_id).where(
        Order.order_no.in_([item.entity_id for item in notifications])
    )
    order_scope = owner_scope_filter(Order.owner_id, user, db)
    account_scope = account_scope_filter(db, user)
    if order_scope is not None:
        stmt = stmt.where(order_scope)
    if account_scope is not None:
        stmt = stmt.where(account_scope)
    pairs = db.execute(stmt).all()
    if not pairs:
        return []
    orders = [order for order, _ in pairs]
    payload_by_id = {item["id"]: item for item in _order_list_payload(db, orders, accounts=[account for _, account in pairs])}
    account_by_order = {order.id: account for order, account in pairs}
    extra_values = {order.id: dict(order.form_extra or {}) for order in orders}
    responsible_ids = {
        value for values in extra_values.values()
        for value in (values.get("business_responsible_ids") or [])
        if isinstance(value, int) and value > 0
    }
    names = {item.id: item.display_name or item.username for item in db.scalars(
        select(User).where(User.id.in_(responsible_ids))
    ).all()} if responsible_ids else {}
    context = load_event_context(db, [order.id for order in orders])
    outputs = build_order_outputs(
        orders, order_extra_values=extra_values, field_defs_by_type={},
        cashflows_by_order={}, customers_by_order={}, counterparties_by_order={},
        rebates_by_order={}, events_by_order=context.events_by_order,
        operator_names_by_order={
            order.id: [names[value] for value in (extra_values[order.id].get("business_responsible_ids") or []) if value in names]
            for order in orders
        },
    )
    output_by_number = {item.order_no: item for item in outputs}
    results = []
    for notification in notifications:
        order = output_by_number.get(notification.entity_id)
        if order is None:
            continue
        account = account_by_order[order.order_id]
        payload = payload_by_id[order.order_id]
        source_order = next(item for item in orders if item.id == order.order_id)
        profit = payload["profit_base"]
        view = build_detail_view([order])
        recovery = next((row for row in view.execution_rows if row.category == "INBOUND"), None)
        results.append(ProfitNotificationDetailOut(
            notification_id=notification.id, order_no=order.order_no, order_type=order.order_type,
            sale_amount=_sale_amount(order.order_type, order.events), stock_no=account.stock_no,
            game_type=payload["account_game_type"], cost_amount=payload["cost_amount"],
            allocatable_profit=allocatable_profit_for(profit, company_rate_for_order(source_order, profit)),
            inventory_entry_at=account.inventory_entry_at, removed_at=view.lifecycle.removed_at,
            recovery_operator=recovery.operator if recovery else None,
        ))
    return results
