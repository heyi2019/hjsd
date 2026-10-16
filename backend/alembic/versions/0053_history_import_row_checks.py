"""enforce history import batch and row identity invariants"""
from __future__ import annotations

from alembic import op


revision = "0053_history_import_row_checks"
down_revision = "0052_reconciliation_installment_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("import_batches") as batch:
        batch.create_check_constraint(
            "counts_nonneg",
            "row_count >= 0 AND unmapped_count >= 0",
        )

    with op.batch_alter_table("import_rows") as batch:
        batch.create_check_constraint("row_no_positive", "row_no > 0")
        batch.create_unique_constraint(
            "uq_import_rows_batch_row", ["batch_id", "row_no"]
        )


def downgrade() -> None:
    with op.batch_alter_table("import_rows") as batch:
        batch.drop_constraint("uq_import_rows_batch_row", type_="unique")
        batch.drop_constraint("row_no_positive", type_="check")

    with op.batch_alter_table("import_batches") as batch:
        batch.drop_constraint("counts_nonneg", type_="check")
