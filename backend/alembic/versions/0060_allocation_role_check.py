"""enforce closed order profit allocation roles"""
from __future__ import annotations

from alembic import op


revision = "0060_allocation_role_check"
down_revision = "0059_unique_order_type_prefix"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("order_profit_allocations") as batch:
        batch.create_check_constraint(
            "allocation_role_valid",
            "role IN ('OWNER', 'BUYER', 'SALES', 'SERVICE')",
        )


def downgrade() -> None:
    with op.batch_alter_table("order_profit_allocations") as batch:
        batch.drop_constraint("allocation_role_valid", type_="check")
