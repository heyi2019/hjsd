"""新增质量异常工单（QLT-01-05）。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0077_quality_issues"
down_revision = "0076_period_locks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "quality_issues",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("issue_no", sa.String(length=32), nullable=False),
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("severity", sa.String(length=16), nullable=False),
        sa.Column("title", sa.String(length=256), nullable=False),
        sa.Column("entity_type", sa.String(length=64), nullable=False),
        sa.Column("entity_id", sa.String(length=128), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("details", sa.JSON(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("assignee_id", sa.Integer(), nullable=True),
        sa.Column("resolution", sa.Text(), nullable=True),
        sa.Column("evidence", sa.Text(), nullable=True),
        sa.Column("closed_by", sa.String(length=64), nullable=True),
        sa.Column("closed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=False),
        sa.Column("updated_by", sa.String(length=64), nullable=False),
        sa.CheckConstraint(
            "status IN ('OPEN', 'IN_PROGRESS', 'CLOSED')",
            name="quality_issue_status_valid",
        ),
        sa.ForeignKeyConstraint(["assignee_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("issue_no"),
    )
    op.create_index("ix_quality_issues_status", "quality_issues", ["status"])
    op.create_index(
        "ix_quality_issues_entity", "quality_issues", ["entity_type", "entity_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_quality_issues_entity", table_name="quality_issues")
    op.drop_index("ix_quality_issues_status", table_name="quality_issues")
    op.drop_table("quality_issues")
