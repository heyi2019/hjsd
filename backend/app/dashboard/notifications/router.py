"""SYS-01-04 系统通知接口。"""
from __future__ import annotations

from datetime import datetime

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
from app.shared.scope import owner_scope_filter
from app.dashboard.notifications.profit_details import profit_details_for_notifications
from app.dashboard.notifications import query, schemas, service
from app.dashboard.notifications.inventory import sync_inventory_notifications_for_user

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
        items, _ = query.list_notifications(
            db, recipient_user_id=user.id, unread_only=True,
            notification_type=service.PROFIT_PENDING, entity_type="order", limit=1,
        )
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
    items, next_cursor = query.inbox_page(db, recipient_user_id=user.id, category=category, cursor=cursor, limit=limit)
    return schemas.NotificationInboxOut(items=[schemas.NotificationOut.model_validate(item) for item in items], next_cursor=next_cursor)


@router.get("/notifications", response_model=schemas.NotificationListOut)
def list_my_notifications(
    unread_only: bool = Query(default=False),
    read_only: bool = Query(default=False),
    category: str | None = Query(default=None, pattern="^(sale|inventory)$"),
    notification_type: str | None = Query(default=None),
    entity_type: str | None = Query(default=None),
    before_id: int | None = Query(default=None, ge=1),
    before_created_at: datetime | None = Query(default=None),
    sort_by_time: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> schemas.NotificationListOut:
    items, total = query.list_notifications(
        db,
        recipient_user_id=user.id,
        unread_only=unread_only,
        read_only=read_only,
        category=category,
        notification_type=notification_type,
        entity_type=entity_type,
        before_id=before_id,
        before_created_at=before_created_at,
        sort_by_time=sort_by_time,
        limit=limit,
    )
    return schemas.NotificationListOut(
        items=[schemas.NotificationOut.model_validate(item) for item in items],
        total=total,
        unread_total=service.unread_count(db, recipient_user_id=user.id),
    )


@router.post("/notifications/read", response_model=schemas.NotificationReadOut)
def mark_notifications_read(
    payload: schemas.NotificationReadRequest,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> schemas.NotificationReadOut:
    ids = service.mark_read_batch(
        db,
        payload.ids,
        recipient_user_id=user.id,
        actor=user.username,
    )
    return schemas.NotificationReadOut(read_ids=ids)


__all__ = ["router"]
