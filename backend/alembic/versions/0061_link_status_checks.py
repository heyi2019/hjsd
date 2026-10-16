"""enforce closed link status values"""
from __future__ import annotations

from alembic import op


revision = "0061_link_status_checks"
down_revision = "0060_allocation_role_check"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("orders") as batch:
        batch.create_check_constraint(
            "order_link_status_valid",
            "link_status IN ('LINKED', 'UNLINKED', 'ORPHAN', 'UNLINKED_TRANSFER')",
        )
    with op.batch_alter_table("rebate_records") as batch:
        batch.create_check_constraint(
            "rebate_link_status_valid",
            "link_status IN ('LINKED', 'UNLINKED', 'ORPHAN', 'UNLINKED_TRANSFER')",
        )


def downgrade() -> None:
    with op.batch_alter_table("rebate_records") as batch:
        batch.drop_constraint("rebate_link_status_valid", type_="check")
    with op.batch_alter_table("orders") as batch:
        batch.drop_constraint("order_link_status_valid", type_="check")
