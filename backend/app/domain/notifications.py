"""系统通知模型（SYS-01-04）。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.domain.base import Base
from app.domain.base import AuditMixin


class Notification(Base, AuditMixin):
    """面向单个用户的跟进提醒；不承载业务事实。"""

    __tablename__ = "notifications"
    __table_args__ = (
        Index("ix_notifications_recipient_read", "recipient_user_id", "read_at"),
        Index("ix_notifications_entity", "entity_type", "entity_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    notification_no: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    recipient_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    notification_type: Mapped[str] = mapped_column(String(64), nullable=False)
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(128), nullable=False)
    read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


__all__ = ["Notification"]
