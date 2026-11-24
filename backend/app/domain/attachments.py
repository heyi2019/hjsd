"""业务附件模型（订单详情图片等）。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.domain.base import Base
from app.domain.base import AuditMixin


class Attachment(Base, AuditMixin):
    """统一凭证附件索引；实体关联采用受控多态键，不复制业务事实。"""

    __tablename__ = "attachments"
    __table_args__ = (
        Index("ix_attachments_entity", "entity_type", "entity_id"),
        Index("ix_attachments_active", "deleted_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # 仅保留历史编号供旧审计记录追溯，新附件不再发号。
    attachment_no: Mapped[str | None] = mapped_column(String(32), nullable=True, unique=True)
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(128), nullable=False)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    content_type: Mapped[str] = mapped_column(String(128), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


__all__ = ["Attachment"]
