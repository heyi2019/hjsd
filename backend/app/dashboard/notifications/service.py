"""系统通知服务：只负责提醒的生成、查询和已读状态。"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import NotFound, Validation
from app.shared.numbering import allocate_number
from app.core.time import now_second
from app.domain.enums import SequenceKey
from app.domain.notifications import Notification

PROFIT_PENDING = "PROFIT_PENDING"
PROFIT_ALLOCATED = "PROFIT_ALLOCATED"


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
    notification_type: str | None = None,
    entity_type: str | None = None,
    before_id: int | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[Notification], int]:
    stmt = select(Notification).where(Notification.recipient_user_id == recipient_user_id)
    count_stmt = select(func.count(Notification.id)).where(
        Notification.recipient_user_id == recipient_user_id
    )
    if notification_type:
        stmt = stmt.where(Notification.notification_type == notification_type)
        count_stmt = count_stmt.where(Notification.notification_type == notification_type)
    if entity_type:
        stmt = stmt.where(Notification.entity_type == entity_type)
        count_stmt = count_stmt.where(Notification.entity_type == entity_type)
    if before_id is not None:
        stmt = stmt.where(Notification.id < before_id)
        count_stmt = count_stmt.where(Notification.id < before_id)
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))
        count_stmt = count_stmt.where(Notification.read_at.is_(None))
    rows = list(
        session.scalars(
            stmt.order_by(Notification.id.desc()).limit(limit).offset(offset)
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
            Notification.notification_type.in_((PROFIT_PENDING, PROFIT_ALLOCATED)),
        )
        .group_by(Notification.notification_type)
    ).all()
    counts = {notification_type: int(total) for notification_type, total in rows}
    return {
        "pending_profit_count": counts.get(PROFIT_PENDING, 0),
        "allocated_profit_count": counts.get(PROFIT_ALLOCATED, 0),
    }


def mark_read(
    session: Session,
    notification_id: int,
    *,
    recipient_user_id: int,
    actor: str,
) -> Notification:
    notification = session.scalar(
        select(Notification).where(
            Notification.id == notification_id,
            Notification.recipient_user_id == recipient_user_id,
        )
    )
    if notification is None:
        raise NotFound("通知不存在")
    if notification.read_at is None:
        # 与全库其余写入路径统一：本地无时区时间，精确到秒。
        notification.read_at = now_second()
        notification.updated_by = actor
        session.flush()
    return notification


__all__ = [
    "PROFIT_ALLOCATED",
    "PROFIT_PENDING",
    "create_notification",
    "ensure_notification",
    "list_notifications",
    "mark_read",
    "unread_profit_counts",
    "unread_count",
]
