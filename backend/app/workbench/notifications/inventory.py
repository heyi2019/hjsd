"""为当前用户生成可见库存的超期提醒。"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from sqlalchemy import String, cast, exists, select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.core.security import CurrentUser, PERM_FINANCE_READ, PERM_ORDER_CREATE
from app.domain.notifications import Notification
from app.domain.trade import Account, Order
from app.domain.enums import SequenceKey
from app.shared.numbering import allocate_numbers
from app.domain.users import User
from app.workbench.notifications import service


def sync_inventory_notifications_for_user(db: Session, user: CurrentUser) -> int:
    """为当前用户可见的超期库存生成一次提醒，重复刷新不重复生成。"""
    if not user.has_any((PERM_ORDER_CREATE, PERM_FINANCE_READ)):
        return 0
    from app.business.stocks.inventory import _inventory_ledger_scope
    from app.workbench.service import _reminder_config

    # 与同用户同步/已读操作串行，同时允许通知插入时的外键 KEY SHARE，避免与编号锁死锁。
    db.scalar(select(User.id).where(User.id == user.id).with_for_update(key_share=True))
    days = _reminder_config(db)["inventory_aging_days"]
    cutoff = datetime.combine(date.today() - timedelta(days=days), time.min)
    already_notified = exists(select(Notification.id).where(
        Notification.recipient_user_id == user.id,
        Notification.notification_type == service.INVENTORY_AGING,
        Notification.entity_type == "account",
        Notification.entity_id == cast(Account.id, String),
    ))
    pairs = db.execute(_inventory_ledger_scope(db, user).where(
        Account.inventory_entry_at < cutoff, ~already_notified,
    ).order_by(Account.id, Order.id)).all()
    # 同一库存可能关联多条在途订单；仍按库存账号只生成一条。
    pending = {}
    for account, order in pairs:
        pending.setdefault(account.id, (account, order))
    numbers = allocate_numbers(db, SequenceKey.NOTIFICATION, len(pending))
    notifications = []
    for number, (account, order) in zip(numbers, pending.values()):
        key = str(account.id)
        game_type = account.game_type or (order.account_snapshot or {}).get("game_type") or "未设置游戏类型"
        notifications.append(Notification(
            notification_no=number, recipient_user_id=user.id, notification_type=service.INVENTORY_AGING,
            title="库存超期提醒", message=f"订单 {order.order_no} · {game_type} · 成本 {to_money(account.cost_amount)} · 库存 {account.stock_no or key} 已超过 {days} 天",
            entity_type="account", entity_id=key, created_by="system", updated_by="system",
        ))
    db.add_all(notifications)
    db.flush()
    return len(notifications)
