"""移除异常工单（QLT-01）链路

异常工作台全链路删除（2026-10-13 用户裁决）：检测只靠手动触发、无定时任务，
生产环境零有机使用（quality_issues 仅 2 条试跑残留）、工单生命周期无前端指派入口，
且检测规则与既有业务页面重复。保留 MIG-01 历史导入（未映射行改由
import_rows.issue_note 留痕，不再开工单）。

功能编号：QLT-01（移除）
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010_drop_quality_issues"
down_revision = "0009_rename_fks_to_named"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 幂等：表/索引不存在时直接跳过（SQLite DROP ... IF EXISTS）
    op.execute("DROP INDEX IF EXISTS ix_quality_issues_type_status")
    op.execute("DROP INDEX IF EXISTS ix_quality_issues_detected")
    op.execute("DROP TABLE IF EXISTS quality_issues")
    # 异常工单编号域随之废弃（document_sequences 无外键，直接清理种子行）
    op.execute("DELETE FROM document_sequences WHERE sequence_key = 'ISSUE'")


def downgrade() -> None:
    # 兜底重建：结构与 0003/0004 终态一致（CHECK 取含 UNLINKED_TRANSFER 的全量枚举）
    if not sa.inspect(op.get_bind()).has_table("quality_issues"):
        op.create_table(
            "quality_issues",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("issue_no", sa.String(32), nullable=False, unique=True),
            sa.Column("issue_type", sa.String(32), nullable=False),
            sa.Column("severity", sa.String(16), nullable=False, server_default="MEDIUM"),
            sa.Column("status", sa.String(16), nullable=False, server_default="OPEN"),
            sa.Column("entity_type", sa.String(32), nullable=False),
            sa.Column("entity_id", sa.Integer(), nullable=True),
            sa.Column("entity_label", sa.String(64), nullable=True),
            sa.Column("amount", sa.Numeric(18, 2), nullable=False, server_default="0"),
            sa.Column("detected_on", sa.Date(), nullable=False),
            sa.Column("owner_id", sa.Integer(), nullable=True),
            sa.Column("resolution", sa.Text(), nullable=True),
            sa.Column("closed_at", sa.DateTime(), nullable=True),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("created_by", sa.String(64), nullable=False, server_default="system"),
            sa.Column("updated_by", sa.String(64), nullable=False, server_default="system"),
            sa.CheckConstraint(
                "issue_type IN ("
                "'UNROUTED_EVENT','SINGLE_SIDED_TRANSFER','NEGATIVE_AVAILABLE','TH_UNCLOSED',"
                "'UNCOLLECTED_REBATE','OVERDUE_INSTALLMENT','ACCOUNT_CONFLICT',"
                "'ORPHAN_CASHFLOW','HISTORY_UNMAPPED','UNLINKED_TRANSFER')",
                name="issue_type_valid",
            ),
            sa.CheckConstraint(
                "severity IN ('BLOCKER','HIGH','MEDIUM','LOW')", name="issue_severity_valid"
            ),
            sa.CheckConstraint(
                "status IN ('OPEN','ASSIGNED','RESOLVED','CLOSED','IGNORED')",
                name="issue_status_valid",
            ),
        )
        op.create_index(
            "ix_quality_issues_type_status", "quality_issues", ["issue_type", "status"]
        )
        op.create_index("ix_quality_issues_detected", "quality_issues", ["detected_on"])
    op.execute(
        "INSERT INTO document_sequences(sequence_key, prefix, padding, current_value, "
        "created_at, updated_at) SELECT 'ISSUE','QI',4,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP "
        "WHERE NOT EXISTS (SELECT 1 FROM document_sequences WHERE sequence_key='ISSUE')"
    )
