"""prevent order number prefix collisions"""
from __future__ import annotations

from alembic import op


revision = "0059_unique_order_type_prefix"
down_revision = "0058_policy_scope_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("order_type_defs") as batch:
        batch.create_unique_constraint(
            "uq_order_type_defs_sequence_prefix",
            ["sequence_prefix"],
        )


def downgrade() -> None:
    with op.batch_alter_table("order_type_defs") as batch:
        batch.drop_constraint("uq_order_type_defs_sequence_prefix", type_="unique")
