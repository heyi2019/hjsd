"""移除返点预计到账字段及其索引。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0059_remove_rebate_expected_on"
down_revision = "0058_add_rebate_operator_user_ids"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("rebate_records") as batch:
        batch.drop_index("ix_rebate_records_expected_status")
        batch.drop_column("expected_on")


def downgrade() -> None:
    with op.batch_alter_table("rebate_records") as batch:
        batch.add_column(sa.Column("expected_on", sa.Date(), nullable=True))
        batch.create_index(
            "ix_rebate_records_expected_status",
            ["expected_on", "status"],
            unique=False,
        )
