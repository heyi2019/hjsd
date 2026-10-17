"""remove quality issue assignment"""
from __future__ import annotations

from typing import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("quality_issues", schema=None) as batch_op:
        batch_op.drop_column("assignee_id")


def downgrade() -> None:
    with op.batch_alter_table("quality_issues", schema=None) as batch_op:
        batch_op.add_column(sa.Column("assignee_id", sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            "fk_quality_issues_assignee_id",
            "users",
            ["assignee_id"],
            ["id"],
            ondelete="SET NULL",
        )
