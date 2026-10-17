"""SYS-01-04 系统通知接口。"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_ORDER_EXCEPTION_APPROVE,
    CurrentUser,
    get_current_user,
    require_permissions,
)
from app.finance import service as finance_service
from app.notifications import schemas, service

router = APIRouter(tags=["SYS-01-04 系统通知"])
sync_access = require_permissions(PERM_ORDER_EXCEPTION_APPROVE)


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


@router.post(
    "/notifications/sync-overdue-rebates",
    response_model=schemas.NotificationSyncOut,
)
def sync_overdue_rebate_notifications(
    as_of: date | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = sync_access,
) -> schemas.NotificationSyncOut:
    """同步返点逾期跟进通知；供定时任务调用，重复执行不会重复建通知。"""
    return schemas.NotificationSyncOut.model_validate(
        finance_service.sync_overdue_rebate_notifications(
            db,
            as_of=as_of or date.today(),
            actor=user.username,
        )
    )


__all__ = ["router"]
