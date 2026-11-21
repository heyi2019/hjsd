"""系统通知服务：只负责提醒的生成、查询和已读状态。"""
from __future__ import annotations

from datetime import datetime
import base64
import json

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.shared.numbering import allocate_number
from app.domain.enums import SequenceKey
from app.domain.notifications import Notification

PROFIT_PENDING = "PROFIT_PENDING"
PROFIT_ALLOCATED = "PROFIT_ALLOCATED"
INVENTORY_AGING = "INVENTORY_AGING"


def inbox_page(session: Session, *, recipient_user_id: int, category: str, cursor: str | None, limit: int) -> tuple[list[Notification], str | None]:
    """按未读优先和通知时间分页；同一轮分页不重复返回期间刚读过的消息。"""
    snapshot = datetime.now()
    phase = "unread"
    before_time = None
    before_id = None
    if cursor:
        try:
            payload = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
            if payload["category"] != category or payload["phase"] not in ("unread", "read"):
                raise ValueError()
            snapshot = datetime.fromisoformat(payload["snapshot"])
            before_time = datetime.fromisoformat(payload["time"])
            before_id = int(payload["id"])
            phase = payload["phase"]
            if snapshot.tzinfo or before_time.tzinfo or before_id < 1:
                raise ValueError()
        except (ValueError, KeyError, TypeError, UnicodeError, json.JSONDecodeError) as exc:
            raise Validation("通知分页游标无效") from exc
    base = select(Notification).where(Notification.recipient_user_id == recipient_user_id)
    if category == "sale":
        base = base.where(Notification.notification_type.in_([PROFIT_PENDING, PROFIT_ALLOCATED]))
    elif category == "inventory":
        base = base.where(Notification.notification_type == INVENTORY_AGING)
    rows: list[Notification] = []
    for current in (["unread"] if category == "latest" else ["unread", "read"]):
        if phase == "read" and current == "unread":
            continue
        stmt = base.where(Notification.read_at.is_(None) if current == "unread" else Notification.read_at <= snapshot)
        if before_time is not None and current == phase:
            stmt = stmt.where(or_(Notification.created_at < before_time, and_(Notification.created_at == before_time, Notification.id < before_id)))
        rows.extend(session.scalars(stmt.order_by(Notification.created_at.desc(), Notification.id.desc()).limit(limit + 1 - len(rows))).all())
        if len(rows) > limit:
            break
    if len(rows) <= limit:
        return rows, None
    last = rows[limit - 1]
    data = {"category": category, "phase": "unread" if last.read_at is None else "read", "time": last.created_at.isoformat(), "id": last.id, "snapshot": snapshot.isoformat()}
    return rows[:limit], base64.urlsafe_b64encode(json.dumps(data).encode()).decode()


def create_notification(
    session: Session,
    *,
    recipient_user_id: int,
    notification_type: str,
    title: str,
    message: str,
    entity_type: str,
    entity_id: str,
    actor: str = "system",
) -> Notification:
    """创建一条用户通知；调用方与来源业务动作共用同一事务。"""
    if not title.strip() or not message.strip():
        raise Validation("通知标题和内容不能为空")
    if not entity_type.strip() or not str(entity_id).strip():
        raise Validation("通知来源对象不能为空")
    notification = Notification(
        notification_no=allocate_number(session, SequenceKey.NOTIFICATION),
        recipient_user_id=recipient_user_id,
        notification_type=notification_type.strip(),
        title=title.strip(),
        message=message.strip(),
        entity_type=entity_type.strip(),
        entity_id=str(entity_id).strip(),
        created_by=actor,
        updated_by=actor,
    )
    session.add(notification)
    session.flush()
    return notification


def ensure_notification(
    session: Session,
    *,
    recipient_user_id: int,
    notification_type: str,
    title: str,
    message: str,
    entity_type: str,
    entity_id: str,
    actor: str = "system",
) -> tuple[Notification, bool]:
    """按接收人、类型和来源对象幂等创建通知，返回（记录、是否新建）。"""
    existing = session.scalar(
        select(Notification).where(
            Notification.recipient_user_id == recipient_user_id,
            Notification.notification_type == notification_type.strip(),
            Notification.entity_type == entity_type.strip(),
            Notification.entity_id == str(entity_id).strip(),
        )
    )
    if existing is not None:
        return existing, False
    return (
        create_notification(
            session,
            recipient_user_id=recipient_user_id,
            notification_type=notification_type,
            title=title,
            message=message,
            entity_type=entity_type,
            entity_id=entity_id,
            actor=actor,
        ),
        True,
    )


def list_notifications(
    session: Session,
    *,
    recipient_user_id: int,
    unread_only: bool = False,
    read_only: bool = False,
    category: str | None = None,
    notification_type: str | None = None,
    entity_type: str | None = None,
    before_id: int | None = None,
    before_created_at: datetime | None = None,
    sort_by_time: bool = False,
    limit: int = 50,
) -> tuple[list[Notification], int]:
    if sort_by_time and (before_id is None) != (before_created_at is None):
        raise Validation("通知时间分页需要同时提供时间和编号")
    stmt = select(Notification).where(Notification.recipient_user_id == recipient_user_id)
    count_stmt = select(func.count(Notification.id)).where(
        Notification.recipient_user_id == recipient_user_id
    )
    if notification_type:
        stmt = stmt.where(Notification.notification_type == notification_type)
        count_stmt = count_stmt.where(Notification.notification_type == notification_type)
    if category:
        kinds = [PROFIT_PENDING, PROFIT_ALLOCATED] if category == "sale" else [INVENTORY_AGING]
        stmt = stmt.where(Notification.notification_type.in_(kinds))
        count_stmt = count_stmt.where(Notification.notification_type.in_(kinds))
    if entity_type:
        stmt = stmt.where(Notification.entity_type == entity_type)
        count_stmt = count_stmt.where(Notification.entity_type == entity_type)
    if before_created_at is not None and before_id is not None and sort_by_time:
        older = or_(Notification.created_at < before_created_at, and_(Notification.created_at == before_created_at, Notification.id < before_id))
        stmt = stmt.where(older)
        count_stmt = count_stmt.where(older)
    elif before_id is not None:
        stmt = stmt.where(Notification.id < before_id)
        count_stmt = count_stmt.where(Notification.id < before_id)
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))
        count_stmt = count_stmt.where(Notification.read_at.is_(None))
    if read_only:
        stmt = stmt.where(Notification.read_at.is_not(None))
        count_stmt = count_stmt.where(Notification.read_at.is_not(None))
    rows = list(
        session.scalars(
            stmt.order_by(*([Notification.created_at.desc(), Notification.id.desc()] if sort_by_time else [Notification.id.desc()])).limit(limit)
        ).all()
    )
    return rows, int(session.scalar(count_stmt) or 0)


def unread_count(session: Session, *, recipient_user_id: int) -> int:
    return int(
        session.scalar(
            select(func.count(Notification.id)).where(
                Notification.recipient_user_id == recipient_user_id,
                Notification.read_at.is_(None),
            )
        )
        or 0
    )


def unread_profit_counts(session: Session, *, recipient_user_id: int) -> dict[str, int]:
    """按分润阶段统计用户未读通知，不加载通知明细。"""
    rows = session.execute(
        select(Notification.notification_type, func.count(Notification.id))
        .where(
            Notification.recipient_user_id == recipient_user_id,
            Notification.read_at.is_(None),
            Notification.entity_type == "order",
            Notification.notification_type.in_((PROFIT_PENDING, PROFIT_ALLOCATED)),
        )
        .group_by(Notification.notification_type)
    ).all()
    counts = {notification_type: int(total) for notification_type, total in rows}
    return {
        "pending_profit_count": counts.get(PROFIT_PENDING, 0),
        "allocated_profit_count": counts.get(PROFIT_ALLOCATED, 0),
    }


def mark_read_batch(
    session: Session,
    notification_ids: list[int],
    *,
    recipient_user_id: int,
    actor: str,
) -> list[int]:
    ids = list(session.scalars(select(Notification.id).where(
        Notification.id.in_(notification_ids), Notification.recipient_user_id == recipient_user_id,
    )).all())
    if ids:
        session.execute(update(Notification).where(
            Notification.id.in_(ids), Notification.recipient_user_id == recipient_user_id,
            Notification.read_at.is_(None),
        ).values(read_at=datetime.now(), updated_by=actor))
        session.flush()
    return ids


__all__ = [
    "INVENTORY_AGING",
    "PROFIT_ALLOCATED",
    "PROFIT_PENDING",
    "create_notification",
    "ensure_notification",
    "list_notifications",
    "mark_read_batch",
    "unread_profit_counts",
    "unread_count",
]
