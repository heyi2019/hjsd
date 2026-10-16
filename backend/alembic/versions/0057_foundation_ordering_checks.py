"""enforce nonnegative ordering for business types and routes"""
from __future__ import annotations

from alembic import op


revision = "0057_foundation_ordering_checks"
down_revision = "0056_field_definition_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("order_type_defs") as batch:
        batch.create_check_constraint(
            "order_type_sort_order_nonnegative",
            "sort_order >= 0",
        )
    with op.batch_alter_table("order_type_pools") as batch:
        batch.create_check_constraint(
            "route_priority_nonnegative",
            "priority >= 0",
        )


def downgrade() -> None:
    with op.batch_alter_table("order_type_pools") as batch:
        batch.drop_constraint("route_priority_nonnegative", type_="check")
    with op.batch_alter_table("order_type_defs") as batch:
        batch.drop_constraint("order_type_sort_order_nonnegative", type_="check")
