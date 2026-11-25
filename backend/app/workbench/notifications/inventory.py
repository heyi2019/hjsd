"""为当前用户生成可见库存的超期提醒。"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from sqlalchemy import String, cast, exists, select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.core.security import CurrentUser, PERM_FINANCE_READ, PERM_ORDER_CREATE
from app.domain.notifications import Notification
from app.domain.trade import Account, Order
from app.workbench.notifications import service
from ._writes import add_numbered_notifications, lock_recipient


def sync_inventory_notifications_for_user(db: Session, user: CurrentUser) -> int:
    """为当前用户可见的超期库存生成一次提醒，重复刷新不重复生成。"""
    if not user.has_any((PERM_ORDER_CREATE, PERM_FINANCE_READ)):
        return 0
    from app.business.inventory.inventory import _inventory_ledger_scope
    from app.shared.reminder_config import read_reminder_config

    # 与同用户同步/已读操作串行，同时允许通知插入时的外键 KEY SHARE，避免与编号锁死锁。
    lock_recipient(db, user.id)
    days = read_reminder_config(db)["inventory_aging_days"]
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
    records = []
    for account, order in pending.values():
        key = str(account.id)
        game_type = account.game_type or (order.account_snapshot or {}).get("game_type") or "未设置游戏类型"
        records.append((key, f"订单 {order.order_no} · {game_type} · 成本 {to_money(account.cost_amount)} · 库存 {account.stock_no or key} 已超过 {days} 天"))
    return add_numbered_notifications(db, user_id=user.id, notification_type=service.INVENTORY_AGING,
                                      title="库存超期提醒", entity_type="account", records=records)
