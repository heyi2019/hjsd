"""SYS-01-04 系统通知接口。"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import select

from app.core.database import get_db
from app.core.money import to_money
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
from app.domain.trade import Account, Order
from app.domain.users import User
from app.shared.scope import owner_scope_filter
from app.dashboard.notifications.profit_details import profit_details_for_notifications
from app.dashboard.notifications import schemas, service

router = APIRouter(tags=["SYS-01-04 系统通知"])


@router.post("/notifications/sync-inventory")
def sync_inventory_notifications(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, int]:
    """为当前用户可见的超期库存生成一次提醒，重复刷新不重复生成。"""
    if not user.has_any((PERM_ORDER_CREATE, PERM_FINANCE_READ)):
        return {"created": 0}
    from app.business.stocks.inventory import _inventory_ledger_scope
    from app.dashboard.service import _reminder_config

    db.scalar(select(User.id).where(User.id == user.id).with_for_update())
    days = _reminder_config(db)["inventory_aging_days"]
    cutoff = datetime.combine(date.today() - timedelta(days=days), time.min)
    pairs = db.execute(_inventory_ledger_scope(db, user).where(Account.inventory_entry_at < cutoff)).all()
    existing = set(db.scalars(select(Notification.entity_id).where(
        Notification.recipient_user_id == user.id,
        Notification.notification_type == service.INVENTORY_AGING,
        Notification.entity_type == "account",
    )).all())
    created = 0
    for account, order in pairs:
        key = str(account.id)
        if key in existing:
            continue
        game_type = account.game_type or (order.account_snapshot or {}).get("game_type") or "未设置游戏类型"
        service.create_notification(
            db, recipient_user_id=user.id, notification_type=service.INVENTORY_AGING,
            title="库存超期提醒", message=f"订单 {order.order_no} · {game_type} · 成本 {to_money(account.cost_amount)} · 库存 {account.stock_no or key} 已超过 {days} 天",
            entity_type="account", entity_id=key,
        )
        existing.add(key)
        created += 1
    return {"created": created}


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
        Notification.notification_type.in_([service.PROFIT_ALLOCATED, service.PROFIT_PENDING]), Notification.entity_type == "order",
    )).all()
    return profit_details_for_notifications(db, notifications, user)


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
    items, total = service.list_notifications(
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
