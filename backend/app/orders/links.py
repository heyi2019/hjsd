"""orders.links：订单关联（订单 ↔ 订单）的建立、解除与查询（ORD-01）。
"""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any
from app.shared.audit import record_audit
from app.core.security import CurrentUser
from ._common import _positive_money
from sqlalchemy import (
    or_,
    select,
)
from sqlalchemy.orm import Session
from app.core.errors import (
    NotFound,
    Validation,
)
from app.domain.trade import (
    Order,
    OrderLink,
)
from app.domain.enums import (
    AuditAction,
    OrderLinkType,
)

from app.shared.order_access import get_order

def create_order_link(
    session: Session,
    order_id: int,
    *,
    related_order_id: int,
    relation_type: str,
    split_ratio: Any = None,
    split_amount: Any = None,
    note: str | None = None,
    form_extra: Mapping[str, Any] | None = None,
    actor: str,
    user: CurrentUser | None = None,
) -> OrderLink:
    """建立上下游订单关系；拆分口径作为关系快照保存，不改写订单金额。"""
    relation = relation_type.strip().upper() if isinstance(relation_type, str) else relation_type
    if relation not in OrderLinkType.values():
        raise Validation(
            "关联方向无效",
            details={"field": "relation_type", "allowed": list(OrderLinkType.values())},
        )
    order = get_order(session, order_id, user)
    related = get_order(session, related_order_id, user)
    if order.id == related.id:
        raise Validation("订单不能关联自身", details={"order_id": order.id})
    source_id, target_id = (
        (related.id, order.id)
        if relation == OrderLinkType.SOURCE.value
        else (order.id, related.id)
    )
    existing = session.scalar(
        select(OrderLink).where(
            OrderLink.source_order_id == source_id,
            OrderLink.target_order_id == target_id,
        )
    )
    if existing is not None:
        raise Validation(
            "订单关联已存在",
            details={"source_order_id": source_id, "target_order_id": target_id},
        )
    ratio = None if split_ratio is None else _positive_money(split_ratio, field="split_ratio")
    if ratio is not None and ratio > Decimal("100"):
        raise Validation("拆分比例不能超过 100%", details={"field": "split_ratio"})
    amount = None if split_amount is None else _positive_money(split_amount, field="split_amount")
    link = OrderLink(
        source_order_id=source_id,
        target_order_id=target_id,
        relation_type=relation,
        split_ratio=ratio,
        split_amount=amount,
        note=note.strip() if isinstance(note, str) and note.strip() else None,
        form_extra=dict(form_extra) if form_extra else None,
        created_by=actor,
        updated_by=actor,
    )
    session.add(link)
    session.flush()
    record_audit(
        session,
        action=AuditAction.ORDER_LINK_CREATE,
        entity_type="order_link",
        entity_id=link.id,
        actor=actor,
        after={
            "source_order_id": source_id,
            "target_order_id": target_id,
            "relation_type": relation,
            "split_ratio": str(ratio) if ratio is not None else None,
            "split_amount": str(amount) if amount is not None else None,
        },
    )
    return link


def delete_order_link(
    session: Session,
    order_id: int,
    link_id: int,
    *,
    actor: str,
    user: CurrentUser | None = None,
) -> None:
    """删除上下游订单关系；只允许删挂在当前订单上的关联，删后可重新建立。"""
    order = get_order(session, order_id, user)
    link = session.get(OrderLink, link_id)
    if (
        link is None
        or (link.source_order_id != order.id and link.target_order_id != order.id)
    ):
        raise NotFound(f"订单关联 {link_id} 不存在", details={"link_id": link_id})
    before = {
        "source_order_id": link.source_order_id,
        "target_order_id": link.target_order_id,
        "relation_type": link.relation_type,
        "split_ratio": str(link.split_ratio) if link.split_ratio is not None else None,
        "split_amount": str(link.split_amount) if link.split_amount is not None else None,
    }
    session.delete(link)
    session.flush()
    record_audit(
        session,
        action=AuditAction.ORDER_LINK_DELETE,
        entity_type="order_link",
        entity_id=link_id,
        actor=actor,
        before=before,
    )


def list_order_links(
    session: Session, order_id: int, user: CurrentUser | None = None
) -> list[dict[str, Any]]:
    """按当前订单视角返回来源单与后续单。"""
    order = get_order(session, order_id, user)
    rows = session.scalars(
        select(OrderLink)
        .where(
            or_(
                OrderLink.source_order_id == order.id,
                OrderLink.target_order_id == order.id,
            )
        )
        .order_by(OrderLink.id)
    ).all()
    order_ids = {
        item_id
        for row in rows
        for item_id in (row.source_order_id, row.target_order_id)
    }
    orders = {
        item.id: item
        for item in session.scalars(select(Order).where(Order.id.in_(order_ids))).all()
    } if order_ids else {}
    result: list[dict[str, Any]] = []
    for row in rows:
        direction = (
            OrderLinkType.FOLLOW_UP.value
            if row.source_order_id == order.id
            else OrderLinkType.SOURCE.value
        )
        result.append(
            {
                "id": row.id,
                "source_order_id": row.source_order_id,
                "source_order_no": orders[row.source_order_id].order_no,
                "target_order_id": row.target_order_id,
                "target_order_no": orders[row.target_order_id].order_no,
                "relation_type": row.relation_type,
                "direction": direction,
                "split_ratio": row.split_ratio,
                "split_amount": row.split_amount,
                "note": row.note,
                "form_extra": row.form_extra,
                "created_at": row.created_at,
            }
        )
    return result
