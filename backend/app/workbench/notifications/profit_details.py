"""为消息列表批量构造可见订单的金额摘要。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.business.router_outputs.list_payload import _order_list_payload
from app.business.inventory._common import scope_filter as account_scope_filter
from app.core.security import CurrentUser
from app.domain.notifications import Notification
from app.domain.trade import Account, Order
from app.funds.profit_allocation.company_settings import get_company_settings
from app.funds.profit_allocation.terms import allocatable_profit_for, company_rate_for_order
from app.shared.scope import owner_scope_filter
from .schemas import ProfitNotificationDetailOut


def profit_details_for_notifications(db: Session, notifications: list[Notification], user: CurrentUser) -> list[ProfitNotificationDetailOut]:
    if not notifications:
        return []
    stmt = select(Order, Account).join(Account, Account.id == Order.account_id).where(
        Order.order_no.in_([item.entity_id for item in notifications])
    )
    for scope in (owner_scope_filter(Order.owner_id, user, db), account_scope_filter(db, user)):
        if scope is not None:
            stmt = stmt.where(scope)
    pairs = db.execute(stmt).all()
    if not pairs:
        return []
    orders = [order for order, _ in pairs]
    payload_by_id = {item["id"]: item for item in _order_list_payload(db, orders, accounts=[account for _, account in pairs])}
    orders_by_number = {order.order_no: order for order in orders}
    results = []
    settings = get_company_settings(db)
    for notification in notifications:
        order = orders_by_number.get(notification.entity_id)
        if order is None:
            continue
        payload = payload_by_id[order.id]
        profit = payload["profit_base"]
        results.append(ProfitNotificationDetailOut(
            notification_id=notification.id, order_no=order.order_no,
            sale_amount=payload["sale_amount"], cost_amount=payload["cost_amount"],
            allocatable_profit=allocatable_profit_for(profit, company_rate_for_order(order, profit, settings)),
        ))
    return results
