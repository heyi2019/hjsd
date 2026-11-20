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
from app.shared.scope import owner_scope_filter
from app.dashboard.notifications.profit_details import profit_details_for_notifications
from app.dashboard.notifications import schemas, service

router = APIRouter(tags=["SYS-01-04 系统通知"])


@router.get("/notifications/pending-order", response_model=schemas.PendingProfitOrderOut)
def pending_profit_order(
    db: Session = Depends(get_db),
    user: CurrentUser = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False),
) -> schemas.PendingProfitOrderOut:
    items, _ = service.list_notifications(
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
        Notification.notification_type == service.PROFIT_ALLOCATED, Notification.entity_type == "order",
    )).all()
    return profit_details_for_notifications(db, notifications, user)


@router.get("/notifications", response_model=schemas.NotificationListOut)
def list_my_notifications(
    unread_only: bool = Query(default=False),
    notification_type: str | None = Query(default=None),
    entity_type: str | None = Query(default=None),
    before_id: int | None = Query(default=None, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> schemas.NotificationListOut:
    items, total = service.list_notifications(
        db,
        recipient_user_id=user.id,
        unread_only=unread_only,
        notification_type=notification_type,
        entity_type=entity_type,
        before_id=before_id,
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
