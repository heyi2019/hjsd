"""SYS-01-04 系统通知接口。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import select

from app.core.database import get_db
from app.core.security import (
    CurrentUser,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
)
from app.settings.auth.session import (
    get_current_user,
    require_permissions,
)
from app.domain.notifications import Notification
from app.domain.trade import Order
from app.domain.users import User
from app.shared.scope import owner_scope_filter
from app.workbench.notifications.profit_details import profit_details_for_notifications
from app.workbench.notifications import query, schemas, service
from app.workbench.notifications.inventory import sync_inventory_notifications_for_user

router = APIRouter(tags=["SYS-01-04 系统通知"])


@router.post("/notifications/sync-inventory")
def sync_inventory_notifications(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, int]:
    return {"created": sync_inventory_notifications_for_user(db, user)}

@router.get("/notifications/pending-order", response_model=schemas.PendingProfitOrderOut)
def pending_profit_order(
    notification_id: int | None = Query(default=None, ge=1),
    db: Session = Depends(get_db),
    user: CurrentUser = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False),
) -> schemas.PendingProfitOrderOut:
    if notification_id is not None:
        item = db.scalar(select(Notification).where(
            Notification.id == notification_id,
            Notification.recipient_user_id == user.id,
            Notification.notification_type == service.PROFIT_PENDING,
            Notification.entity_type == "order",
        ))
        items = [item] if item else []
    else:
        item = db.scalar(select(Notification).where(
            Notification.recipient_user_id == user.id,
            Notification.read_at.is_(None),
            Notification.notification_type == service.PROFIT_PENDING,
            Notification.entity_type == "order",
        ).order_by(Notification.id.desc()).limit(1))
        items = [item] if item else []
    if not items:
        return schemas.PendingProfitOrderOut(order_no=None, order_id=None)
    stmt = select(Order.id).where(Order.order_no == items[0].entity_id)
    scope = owner_scope_filter(Order.owner_id, user, db)
    if scope is not None:
        stmt = stmt.where(scope)
    return schemas.PendingProfitOrderOut(order_no=items[0].entity_id, order_id=db.scalar(stmt))


@router.get("/notifications/profit-details", response_model=list[schemas.ProfitNotificationDetailOut])
def profit_notification_details(
    ids: list[int] = Query(..., max_length=10),
    db: Session = Depends(get_db),
    user: CurrentUser = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False),
) -> list[schemas.ProfitNotificationDetailOut]:
    notifications = db.scalars(select(Notification).where(
        Notification.id.in_(ids), Notification.recipient_user_id == user.id,
        Notification.notification_type.in_([service.PROFIT_ALLOCATED, service.PROFIT_PENDING]), Notification.entity_type == "order",
    )).all()
    return profit_details_for_notifications(db, notifications, user)


@router.get("/notifications/inbox", response_model=schemas.NotificationInboxOut)
def notification_inbox(
    category: str = Query(default="latest", pattern="^(latest|sale|inventory)$"),
    cursor: str | None = Query(default=None, max_length=1024),
    limit: int = Query(default=10, ge=1, le=50),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> schemas.NotificationInboxOut:
    items, next_cursor = query.inbox_page(db, recipient_user_id=user.id, category=category, cursor=cursor, limit=limit, user=user)
    return schemas.NotificationInboxOut(items=[schemas.NotificationOut.model_validate(item) for item in items], next_cursor=next_cursor)


@router.post("/notifications/read", response_model=schemas.NotificationReadOut)
def mark_notifications_read(
    payload: schemas.NotificationReadRequest,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> schemas.NotificationReadOut:
    # 同一接收人的并发已读操作按事务排序，保证返回的位置包含先提交的消息。
    db.scalar(select(User.id).where(User.id == user.id).with_for_update())
    ids = service.mark_read_batch(
        db,
        payload.ids,
        recipient_user_id=user.id,
        actor=user.username,
    )
    read_at, next_read_id = (None, None)
    if len(ids) == 1 and payload.category in ("sale", "inventory"):
        read_at, next_read_id = query.read_position(db, user=user, category=payload.category, notification_id=ids[0])
    return schemas.NotificationReadOut(read_ids=ids, read_at=read_at, next_read_id=next_read_id)


__all__ = ["router"]
