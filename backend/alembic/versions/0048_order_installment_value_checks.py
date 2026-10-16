"""enforce non-negative order amounts and positive installment periods"""
from __future__ import annotations

from alembic import op


revision = "0048_order_installment_value_checks"
down_revision = "0047_rebate_settlement_breakdown_check"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("orders") as batch:
        batch.create_check_constraint(
            "listing_price_nonneg",
            "listing_price IS NULL OR listing_price >= 0",
        )
        batch.create_check_constraint(
            "service_fee_nonneg",
            "service_fee IS NULL OR service_fee >= 0",
        )

    with op.batch_alter_table("installments") as batch:
        batch.create_check_constraint("periods_positive", "periods > 0")


def downgrade() -> None:
    with op.batch_alter_table("installments") as batch:
        batch.drop_constraint("periods_positive", type_="check")

    with op.batch_alter_table("orders") as batch:
        batch.drop_constraint("service_fee_nonneg", type_="check")
        batch.drop_constraint("listing_price_nonneg", type_="check")
