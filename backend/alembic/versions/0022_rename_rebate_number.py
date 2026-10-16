"""统一返点记录编号命名，避免新结构继续使用旧字段名。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0022_rename_rebate_number"
down_revision = "0021_drop_deposit_number"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("rebate_records") as batch:
        batch.alter_column(
            "rebate_group_no",
            new_column_name="rebate_no",
            existing_type=sa.String(length=32),
            existing_nullable=False,
        )
    op.get_bind().execute(
        sa.text(
            "UPDATE document_sequences SET prefix = 'RB' "
            "WHERE sequence_key = 'REBATE'"
        )
    )


def downgrade() -> None:
    with op.batch_alter_table("rebate_records") as batch:
        batch.alter_column(
            "rebate_no",
            new_column_name="rebate_group_no",
            existing_type=sa.String(length=32),
            existing_nullable=False,
        )
    op.get_bind().execute(
        sa.text(
            "UPDATE document_sequences SET prefix = 'REB' "
            "WHERE sequence_key = 'REBATE'"
        )
    )
