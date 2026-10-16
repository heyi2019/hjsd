"""enforce valid document sequence configuration and state"""
from __future__ import annotations

from alembic import op


revision = "0050_sequence_value_checks"
down_revision = "0049_financial_rate_and_release_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("document_sequences") as batch:
        batch.create_check_constraint("padding_positive", "padding > 0")
        batch.create_check_constraint("current_value_nonneg", "current_value >= 0")


def downgrade() -> None:
    with op.batch_alter_table("document_sequences") as batch:
        batch.drop_constraint("current_value_nonneg", type_="check")
        batch.drop_constraint("padding_positive", type_="check")
