"""系统通知服务：只负责提醒的生成、查询和已读状态。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.shared.numbering import allocate_number
from app.domain.enums import SequenceKey
from app.domain.notifications import Notification

PROFIT_PENDING = "PROFIT_PENDING"
PROFIT_ALLOCATED = "PROFIT_ALLOCATED"
INVENTORY_AGING = "INVENTORY_AGING"
INSTALLMENT_OVERDUE = "INSTALLMENT_OVERDUE"


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
    "INSTALLMENT_OVERDUE",
    "PROFIT_ALLOCATED",
    "PROFIT_PENDING",
    "create_notification",
    "ensure_notification",
    "mark_read_batch",
]
