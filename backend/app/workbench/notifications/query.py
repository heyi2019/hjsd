"""通知查询及工作台消息分页。"""
from __future__ import annotations

import base64
import json
from datetime import datetime

from sqlalchemy import String, and_, cast, or_, select
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.domain.notifications import Notification
from app.workbench.notifications.service import INVENTORY_AGING, PROFIT_ALLOCATED, PROFIT_PENDING
from app.core.security import CurrentUser, PERM_FINANCE_READ, PERM_ORDER_CREATE
from app.domain.trade import Account


def visibility_filter(session: Session, user: CurrentUser):
    """历史库存提醒仍需满足当前账号的数据范围。"""
    other = Notification.notification_type != INVENTORY_AGING
    if not user.has_any((PERM_ORDER_CREATE, PERM_FINANCE_READ)):
        return other
    from app.business.stocks._common import scope_filter
    visible = select(cast(Account.id, String))
    scope = scope_filter(session, user)
    if scope is not None:
        visible = visible.where(scope)
    return or_(other, and_(Notification.entity_type == "account", Notification.entity_id.in_(visible)))


def _notification_query(recipient_user_id: int, *, category: str | None = None, notification_type: str | None = None, entity_type: str | None = None):
    stmt = select(Notification).where(Notification.recipient_user_id == recipient_user_id)
    if category == "sale":
        stmt = stmt.where(Notification.notification_type.in_([PROFIT_PENDING, PROFIT_ALLOCATED]))
    elif category == "inventory":
        stmt = stmt.where(Notification.notification_type == INVENTORY_AGING)
    if notification_type:
        stmt = stmt.where(Notification.notification_type == notification_type)
    if entity_type:
        stmt = stmt.where(Notification.entity_type == entity_type)
    return stmt


def read_position(session: Session, *, user: CurrentUser, category: str, notification_id: int) -> tuple[datetime | None, int | None]:
    base = _notification_query(user.id, category=category).where(visibility_filter(session, user))
    item = session.scalar(base.where(Notification.id == notification_id))
    if item is None or item.read_at is None:
        return None, None
    older = or_(Notification.created_at < item.created_at, and_(Notification.created_at == item.created_at, Notification.id < item.id))
    next_id = session.scalar(base.with_only_columns(Notification.id).where(Notification.read_at.is_not(None), older).order_by(Notification.created_at.desc(), Notification.id.desc()).limit(1))
    return item.read_at, next_id


def inbox_page(session: Session, *, recipient_user_id: int, category: str, cursor: str | None, limit: int, user: CurrentUser | None = None) -> tuple[list[Notification], str | None]:
    """按分页开始时的已读状态排序，期间状态变化不造成漏项或重复。"""
    snapshot = datetime.now()
    phase = "unread"
    before_time = None
    before_id = None
    if cursor:
        try:
            payload = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
            if payload["category"] != category or payload["phase"] not in ("unread", "read") or (category == "latest" and payload["phase"] != "unread"):
                raise ValueError()
            snapshot = datetime.fromisoformat(payload["snapshot"])
            before_time = datetime.fromisoformat(payload["time"])
            before_id = int(payload["id"])
            phase = payload["phase"]
            if snapshot.tzinfo or before_time.tzinfo or before_id < 1:
                raise ValueError()
        except (ValueError, KeyError, TypeError, UnicodeError, json.JSONDecodeError) as exc:
            raise Validation("通知分页游标无效") from exc
    base = _notification_query(recipient_user_id, category=category)
    if user is not None:
        base = base.where(visibility_filter(session, user))
    rows: list[Notification] = []
    for current in (["unread"] if category == "latest" else ["unread", "read"]):
        if phase == "read" and current == "unread":
            continue
        unread_at_snapshot = or_(Notification.read_at.is_(None), Notification.read_at > snapshot)
        unread = Notification.read_at.is_(None) if category == "latest" else unread_at_snapshot
        stmt = base.where(unread if current == "unread" else Notification.read_at <= snapshot)
        if before_time is not None and current == phase:
            stmt = stmt.where(or_(Notification.created_at < before_time, and_(Notification.created_at == before_time, Notification.id < before_id)))
        rows.extend(session.scalars(stmt.order_by(Notification.created_at.desc(), Notification.id.desc()).limit(limit + 1 - len(rows))).all())
        if len(rows) > limit:
            break
    if len(rows) <= limit:
        return rows, None
    last = rows[limit - 1]
    was_unread = last.read_at is None or (category != "latest" and last.read_at > snapshot)
    data = {"category": category, "phase": "unread" if was_unread else "read", "time": last.created_at.isoformat(), "id": last.id, "snapshot": snapshot.isoformat()}
    return rows[:limit], base64.urlsafe_b64encode(json.dumps(data).encode()).decode()
