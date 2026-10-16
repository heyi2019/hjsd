"""link rebate reversal rows to their original settlement"""
from __future__ import annotations

from alembic import op


revision = "0054_rebate_reversal_fk"
down_revision = "0053_history_import_row_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("rebate_settlements") as batch:
        batch.create_foreign_key(
            "fk_rebate_settlements_reversal_of_id",
            "rebate_settlements",
            ["reversal_of_id"],
            ["id"],
            ondelete="RESTRICT",
        )


def downgrade() -> None:
    with op.batch_alter_table("rebate_settlements") as batch:
        batch.drop_constraint(
            "fk_rebate_settlements_reversal_of_id",
            type_="foreignkey",
        )
