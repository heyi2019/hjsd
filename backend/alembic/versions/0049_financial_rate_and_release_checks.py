"""enforce financial rate and deposit release invariants"""
from __future__ import annotations

from alembic import op


revision = "0049_financial_rate_and_release_checks"
down_revision = "0048_order_installment_value_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("deposits") as batch:
        batch.create_check_constraint(
            "released_amount_within_paid",
            "returned_amount + lost_amount <= paid_amount",
        )

    with op.batch_alter_table("rebate_records") as batch:
        batch.create_check_constraint("rate_max", "rate <= 100")

    with op.batch_alter_table("order_profit_allocations") as batch:
        batch.create_check_constraint("rate_max", "allocation_rate <= 100")


def downgrade() -> None:
    with op.batch_alter_table("order_profit_allocations") as batch:
        batch.drop_constraint("rate_max", type_="check")

    with op.batch_alter_table("rebate_records") as batch:
        batch.drop_constraint("rate_max", type_="check")

    with op.batch_alter_table("deposits") as batch:
        batch.drop_constraint("released_amount_within_paid", type_="check")
