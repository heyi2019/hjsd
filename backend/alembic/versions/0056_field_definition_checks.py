"""enforce live field type and ordering invariants"""
from __future__ import annotations

from alembic import op


revision = "0056_field_definition_checks"
down_revision = "0055_policy_and_counterparty_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("field_definitions") as batch:
        batch.create_check_constraint(
            "field_type_valid",
            "field_type IN ('TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT')",
        )
        batch.create_check_constraint(
            "field_sort_order_nonnegative",
            "sort_order >= 0",
        )


def downgrade() -> None:
    with op.batch_alter_table("field_definitions") as batch:
        batch.drop_constraint("field_sort_order_nonnegative", type_="check")
        batch.drop_constraint("field_type_valid", type_="check")
