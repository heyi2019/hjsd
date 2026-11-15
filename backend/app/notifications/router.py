"""SYS-01-04 系统通知接口。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    CurrentUser,
    get_current_user,
)
from app.notifications import schemas, service

router = APIRouter(tags=["SYS-01-04 系统通知"])


@router.get("/notifications", response_model=schemas.NotificationListOut)
def list_my_notifications(
    unread_only: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> schemas.NotificationListOut:
    items, total = service.list_notifications(
        db,
        recipient_user_id=user.id,
        unread_only=unread_only,
        limit=limit,
        offset=offset,
    )
    return schemas.NotificationListOut(
        items=[schemas.NotificationOut.model_validate(item) for item in items],
        total=total,
        unread_total=service.unread_count(db, recipient_user_id=user.id),
    )


@router.get("/notifications/summary", response_model=schemas.NotificationSummaryOut)
def notification_summary(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> schemas.NotificationSummaryOut:
    """工作台所需的通知汇总，只返回未读分润通知数。"""
    return schemas.NotificationSummaryOut(
        unread_profit_total=service.unread_profit_count(db, recipient_user_id=user.id)
    )


@router.post("/notifications/{notification_id}/read", response_model=schemas.NotificationOut)
def mark_notification_read(
    notification_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> schemas.NotificationOut:
    notification = service.mark_read(
        db,
        notification_id,
        recipient_user_id=user.id,
        actor=user.username,
    )
    return schemas.NotificationOut.model_validate(notification)


__all__ = ["router"]
