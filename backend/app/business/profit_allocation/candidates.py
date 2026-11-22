"""根据订单事实计算分润人员候选。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import CurrentUser
from app.domain.trade import Order, OrderEvent
from app.domain.users import User


def _ids(value: object) -> list[int]:
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(item for item in value if isinstance(item, int) and not isinstance(item, bool) and item > 0))


def allocation_candidates(session: Session, order: Order, user: CurrentUser | None) -> dict[str, list[int]]:
    events = session.scalars(select(OrderEvent).where(
        OrderEvent.order_id == order.id, OrderEvent.is_posted.is_(True),
    ).order_by(OrderEvent.occurred_on, OrderEvent.id)).all()
    extra = order.form_extra or {}

    def operators(types: set[str], *, exclude: bool = False) -> list[int]:
        return _ids([uid for event in events if (event.event_type not in types) == exclude
                     for uid in (event.operator_user_ids or [])])

    current = session.get(User, user.id) if user is not None else None
    fallback = [current.id] if current is not None and current.is_active else []
    buy = _ids(extra.get("business_responsible_ids")) or operators({"BUY"})
    sell = _ids(extra.get("sell_delivery_responsible_ids")) or operators({"SELL"}) or fallback
    operation = (_ids(extra.get("operation_responsible_ids"))
                 or operators({"BUY", "SELL", "CANCEL"}, exclude=True)
                 or _ids(extra.get("business_responsible_ids")))
    return {"BUY": buy, "SELL": sell, "OPERATION": operation, "COMPANY": []}
