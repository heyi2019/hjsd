"""require transfer ids for internal cashflows"""
from __future__ import annotations

from alembic import op


revision = "0046_cashflow_transfer_link_check"
down_revision = "0045_order_event_portion_check"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("cashflow") as batch:
        batch.create_check_constraint(
            "internal_transfer_link_valid",
            "nature != 'INTERNAL' OR transfer_id IS NOT NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("cashflow") as batch:
        batch.drop_constraint("internal_transfer_link_valid", type_="check")
