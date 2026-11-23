"""通知同步共享的接收人锁与批量写入。"""
from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.enums import SequenceKey
from app.domain.notifications import Notification
from app.domain.users import User
from app.shared.numbering import allocate_numbers


def lock_recipient(db: Session, user_id: int) -> None:
    # 与已读/同步操作串行，仍允许通知外键取得 KEY SHARE，避免锁顺序反转。
    db.scalar(select(User.id).where(User.id == user_id).with_for_update(key_share=True))


def add_numbered_notifications(
    db: Session, *, user_id: int, notification_type: str, title: str,
    entity_type: str, records: Sequence[tuple[str, str]],
) -> int:
    numbers = allocate_numbers(db, SequenceKey.NOTIFICATION, len(records))
    db.add_all([
        Notification(
            notification_no=number, recipient_user_id=user_id, notification_type=notification_type,
            title=title, message=message, entity_type=entity_type, entity_id=entity_id,
            created_by="system", updated_by="system",
        )
        for number, (entity_id, message) in zip(numbers, records, strict=True)
    ])
    db.flush()
    return len(records)
