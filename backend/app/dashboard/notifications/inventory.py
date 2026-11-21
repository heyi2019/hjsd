"""为当前用户生成可见库存的超期提醒。"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.core.security import CurrentUser, PERM_FINANCE_READ, PERM_ORDER_CREATE
from app.domain.notifications import Notification
from app.domain.trade import Account
from app.domain.users import User
from app.dashboard.notifications import service


def sync_inventory_notifications_for_user(db: Session, user: CurrentUser) -> int:
    """为当前用户可见的超期库存生成一次提醒，重复刷新不重复生成。"""
    if not user.has_any((PERM_ORDER_CREATE, PERM_FINANCE_READ)):
        return 0
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
    return created
