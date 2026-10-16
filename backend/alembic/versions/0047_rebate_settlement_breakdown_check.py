"""keep rebate settlement amounts mathematically consistent"""
from __future__ import annotations

from alembic import op


revision = "0047_rebate_settlement_breakdown_check"
down_revision = "0046_cashflow_transfer_link_check"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("rebate_settlements") as batch:
        batch.create_check_constraint(
            "net_amount_matches_breakdown",
            "net_amount = gross_amount - platform_fee",
        )


def downgrade() -> None:
    with op.batch_alter_table("rebate_settlements") as batch:
        batch.drop_constraint("net_amount_matches_breakdown", type_="check")
