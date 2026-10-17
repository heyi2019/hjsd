"""为质量工单补齐 QI 编号序列。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0078_quality_issue_sequence"
down_revision = "0077_quality_issues"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    exists = bind.execute(
        sa.text("SELECT 1 FROM document_sequences WHERE sequence_key = :key"),
        {"key": "QUALITY_ISSUE"},
    ).first()
    if exists is None:
        bind.execute(
            sa.text(
                "INSERT INTO document_sequences "
                "(sequence_key, prefix, padding, current_value) "
                "VALUES (:key, :prefix, :padding, :current_value)"
            ),
            {"key": "QUALITY_ISSUE", "prefix": "QI", "padding": 4, "current_value": 0},
        )


def downgrade() -> None:
    op.execute(
        sa.text("DELETE FROM document_sequences WHERE sequence_key = 'QUALITY_ISSUE'")
    )
