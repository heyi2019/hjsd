"""M4：异常工单 + P2 历史导入批次

覆盖 QLT-01-05（异常工单与关闭）与 MIG-01（历史导入、映射预览、异常保留）。
历史导入只存原始行与人工映射结果，不自动匹配、不补造划转。

功能编号：QLT-01 / MIG-01
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003_m4_quality"
down_revision = "0002_m1_business"
branch_labels = None
depends_on = None


def upgrade() -> None:
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
            "'ORPHAN_CASHFLOW','HISTORY_UNMAPPED')",
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

    op.create_table(
        "import_batches",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("batch_no", sa.String(32), nullable=False, unique=True),
        sa.Column("source_name", sa.String(128), nullable=False),
        sa.Column("source_kind", sa.String(32), nullable=False, server_default="LEGACY_ORDER"),
        sa.Column("status", sa.String(16), nullable=False, server_default="DRAFT"),
        sa.Column("row_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("unmapped_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("committed_at", sa.DateTime(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("created_by", sa.String(64), nullable=False, server_default="system"),
        sa.Column("updated_by", sa.String(64), nullable=False, server_default="system"),
        sa.CheckConstraint(
            "status IN ('DRAFT','MAPPED','COMMITTED','REJECTED')",
            name="import_batch_status_valid",
        ),
    )

    op.create_table(
        "import_rows",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("batch_id", sa.Integer(), sa.ForeignKey("import_batches.id", ondelete="CASCADE"), nullable=False),
        sa.Column("row_no", sa.Integer(), nullable=False),
        sa.Column("raw", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("mapped_order_id", sa.Integer(), sa.ForeignKey("orders.id", ondelete="SET NULL"), nullable=True),
        sa.Column("mapped_account_id", sa.Integer(), sa.ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("mapped_by", sa.String(64), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"),
        sa.Column("issue_note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint(
            "status IN ('PENDING','MAPPED','UNMAPPED','IMPORTED','SKIPPED')",
            name="import_row_status_valid",
        ),
    )
    op.create_index("ix_import_rows_batch", "import_rows", ["batch_id", "status"])

    # 异常工单编号域
    op.execute(
        "INSERT INTO document_sequences(sequence_key, prefix, padding, current_value, "
        "created_at, updated_at) SELECT 'ISSUE','QI',4,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP "
        "WHERE NOT EXISTS (SELECT 1 FROM document_sequences WHERE sequence_key='ISSUE')"
    )
    op.execute(
        "INSERT INTO document_sequences(sequence_key, prefix, padding, current_value, "
        "created_at, updated_at) SELECT 'IMPORT','IMP',4,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP "
        "WHERE NOT EXISTS (SELECT 1 FROM document_sequences WHERE sequence_key='IMPORT')"
    )


def downgrade() -> None:
    op.execute("DELETE FROM document_sequences WHERE sequence_key IN ('ISSUE','IMPORT')")
    op.drop_index("ix_import_rows_batch", table_name="import_rows")
    op.drop_table("import_rows")
    op.drop_table("import_batches")
    op.drop_index("ix_quality_issues_detected", table_name="quality_issues")
    op.drop_index("ix_quality_issues_type_status", table_name="quality_issues")
    op.drop_table("quality_issues")
