"""质量异常工单模型（QLT-01）。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.domain.base import AuditMixin
from app.domain.enums import QualityIssueStatus


class QualityIssue(Base, AuditMixin):
    """扫描异常的责任化处置记录；不直接修改业务事实。"""

    __tablename__ = "quality_issues"
    __table_args__ = (
        CheckConstraint(
            f"status IN {QualityIssueStatus.values()!r}"
            .replace("[", "(")
            .replace("]", ")"),
            name="quality_issue_status_valid",
        ),
        Index("ix_quality_issues_status", "status"),
        Index("ix_quality_issues_entity", "entity_type", "entity_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    issue_no: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    severity: Mapped[str] = mapped_column(String(16), nullable=False)
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(128), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=QualityIssueStatus.OPEN.value
    )
    assignee_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    resolution: Mapped[str | None] = mapped_column(Text, nullable=True)
    evidence: Mapped[str | None] = mapped_column(Text, nullable=True)
    closed_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


__all__ = ["QualityIssue"]
