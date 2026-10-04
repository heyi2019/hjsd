"""domain.quality：异常工单与 P2 历史导入批次（QLT-01 / MIG-01）。

设计红线（MIG-01）：历史导入**只落原始行与人工映射结果**，
禁止自动匹配订单/账号/返点，禁止补造历史单边划转。
"""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.money import Amount
from app.domain.base import AuditMixin, TimestampMixin
from app.domain.enums import (
    ImportBatchStatus,
    ImportRowStatus,
    IssueSeverity,
    IssueStatus,
    IssueType,
)


class QualityIssue(Base, AuditMixin):
    """异常工单：检测任务发现 → 指派 → 处置 → 关闭，全链留痕（QLT-01-05）。"""

    __tablename__ = "quality_issues"
    __table_args__ = (
        CheckConstraint(
            f"issue_type IN {IssueType.values()!r}".replace("[", "(").replace("]", ")"),
            name="issue_type_valid",
        ),
        CheckConstraint(
            f"severity IN {IssueSeverity.values()!r}".replace("[", "(").replace("]", ")"),
            name="issue_severity_valid",
        ),
        CheckConstraint(
            f"status IN {IssueStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="issue_status_valid",
        ),
        Index("ix_quality_issues_type_status", "issue_type", "status"),
        Index("ix_quality_issues_detected", "detected_on"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    issue_no: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    issue_type: Mapped[str] = mapped_column(String(32), nullable=False)
    severity: Mapped[str] = mapped_column(
        String(16), nullable=False, default=IssueSeverity.MEDIUM.value
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=IssueStatus.OPEN.value
    )
    # 对象定位：类型 + 业务 id + 可读单号，便于前端一键跳转
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    entity_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    entity_label: Mapped[str | None] = mapped_column(String(64), nullable=True)
    amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    detected_on: Mapped[date] = mapped_column(Date, nullable=False)
    owner_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    resolution: Mapped[str | None] = mapped_column(Text, nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class ImportBatch(Base, AuditMixin):
    """历史导入批次：整批只读参考，提交后不覆盖新单（MIG-01-01/02）。"""

    __tablename__ = "import_batches"
    __table_args__ = (
        CheckConstraint(
            f"status IN {ImportBatchStatus.values()!r}"
            .replace("[", "(")
            .replace("]", ")"),
            name="import_batch_status_valid",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    batch_no: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    source_name: Mapped[str] = mapped_column(String(128), nullable=False)
    source_kind: Mapped[str] = mapped_column(
        String(32), nullable=False, default="LEGACY_ORDER"
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=ImportBatchStatus.DRAFT.value
    )
    row_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    unmapped_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    committed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    rolled_back_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    rolled_back_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    rollback_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 更正批次指向原批次（MIG-01-08 已确认批次只能走冲销/更正，不允许直接改）
    corrects_batch_id: Mapped[int | None] = mapped_column(
        ForeignKey("import_batches.id", ondelete="SET NULL"), nullable=True
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class ImportRow(Base, TimestampMixin):
    """历史原始行：保留原文与异常，映射必须由人工指派（MIG-01-03/04）。"""

    __tablename__ = "import_rows"
    __table_args__ = (
        CheckConstraint(
            f"status IN {ImportRowStatus.values()!r}"
            .replace("[", "(")
            .replace("]", ")"),
            name="import_row_status_valid",
        ),
        Index("ix_import_rows_batch", "batch_id", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    batch_id: Mapped[int] = mapped_column(
        ForeignKey("import_batches.id", ondelete="CASCADE"), nullable=False
    )
    row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    raw: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # 人工指派结果：为 None 表示未映射，系统绝不自动填
    mapped_order_id: Mapped[int | None] = mapped_column(
        ForeignKey("orders.id", ondelete="SET NULL"), nullable=True
    )
    mapped_account_id: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    mapped_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    mapped_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 补录依据（MIG-01-05）：人工关联必须有依据，禁止无据指派
    mapping_basis: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 映射前后状态快照（MIG-01-05 报表重算且保留前后状态）
    mapped_before: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=ImportRowStatus.PENDING.value
    )
    # 单边划转裁决标记（MIG-01-06）：标 UNLINKED 只留痕，绝不自动生成配对流水
    unlinked_transfer: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    issue_note: Mapped[str | None] = mapped_column(Text, nullable=True)


__all__ = ["ImportBatch", "ImportRow", "QualityIssue"]
