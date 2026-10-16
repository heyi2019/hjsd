"""enforce document sequence bounds and non-empty identifiers"""
from __future__ import annotations

from alembic import op


revision = "0067_sequence_bounds"
down_revision = "0066_cashflow_semantic_check"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("document_sequences") as batch:
        batch.create_check_constraint("padding_max", "padding <= 4")
        batch.create_check_constraint("current_value_max", "current_value <= 9999")
        batch.create_check_constraint(
            "sequence_key_nonempty", "length(trim(sequence_key)) > 0"
        )
        batch.create_check_constraint("prefix_nonempty", "length(trim(prefix)) > 0")


def downgrade() -> None:
    with op.batch_alter_table("document_sequences") as batch:
        batch.drop_constraint("prefix_nonempty", type_="check")
        batch.drop_constraint("sequence_key_nonempty", type_="check")
        batch.drop_constraint("current_value_max", type_="check")
        batch.drop_constraint("padding_max", type_="check")
