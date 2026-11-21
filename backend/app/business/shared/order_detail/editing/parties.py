"""订单详情中的参与方追加。"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import NotFound
from app.core.security import CurrentUser
from app.domain.parties import OrderCounterpartyRole, OrderCustomerRole
from app.domain.trade import Order
from app.business.orders.create import add_counterparty_role, add_customer_role

from .schemas import ExecutionPartyEditItem


def apply_party_edits(
    db: Session,
    account_id: int,
    target_order: Order,
    items: list[ExecutionPartyEditItem],
    user: CurrentUser,
) -> None:
    for item in items:
        order = target_order if item.order_id == target_order.id else db.scalar(
            select(Order).where(Order.id == item.order_id).with_for_update()
        )
        if order is None or order.id != target_order.id or order.account_id != account_id:
            raise NotFound("订单不存在")
        if item.operation == "remove":
            model = OrderCustomerRole if item.entity_type == "customer" else OrderCounterpartyRole
            key = "customer_id" if item.entity_type == "customer" else "counterparty_id"
            role = db.scalar(select(model).where(model.order_id == order.id, getattr(model, key) == item.entity_id, model.role == item.role).with_for_update())
            if role is not None:
                db.delete(role)
            continue
        if item.entity_type == "customer":
            add_customer_role(db, order.id, item.entity_id, item.role, actor=user.username, user=user)
        else:
            add_counterparty_role(db, order.id, item.entity_id, item.role, actor=user.username, user=user)
