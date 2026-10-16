"""enforce order commission and delivery mode semantics"""
from __future__ import annotations

from alembic import op


revision = "0065_order_semantic_checks"
down_revision = "0064_account_context_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("orders") as batch:
        batch.create_check_constraint(
            "order_commission_mode_valid",
            "commission_mode IS NULL OR commission_mode IN ('DEDUCT_FROM_SETTLEMENT', 'SEPARATE_PAYMENT')",
        )
        batch.create_check_constraint(
            "order_commission_payer_valid",
            "commission_payer IS NULL OR commission_payer IN ('BUYER', 'CONSIGNOR', 'PLATFORM')",
        )
        batch.create_check_constraint(
            "order_commission_pair_valid",
            "(commission_mode IS NULL) = (commission_payer IS NULL)",
        )
        batch.create_check_constraint(
            "order_commission_type_valid",
            "order_type = 'DG' OR (commission_mode IS NULL AND commission_payer IS NULL)",
        )

    with op.batch_alter_table("order_events") as batch:
        batch.create_check_constraint(
            "event_delivery_mode_valid",
            "delivery_mode IS NULL OR delivery_mode IN ('PLATFORM_OPERATOR', 'CUSTOMER_SELF')",
        )

    with op.batch_alter_table("installments") as batch:
        batch.create_check_constraint(
            "installment_delivery_mode_valid",
            "delivery_mode IS NULL OR delivery_mode IN ('PLATFORM_OPERATOR', 'CUSTOMER_SELF')",
        )


def downgrade() -> None:
    with op.batch_alter_table("installments") as batch:
        batch.drop_constraint("installment_delivery_mode_valid", type_="check")
    with op.batch_alter_table("order_events") as batch:
        batch.drop_constraint("event_delivery_mode_valid", type_="check")
    with op.batch_alter_table("orders") as batch:
        batch.drop_constraint("order_commission_type_valid", type_="check")
        batch.drop_constraint("order_commission_pair_valid", type_="check")
        batch.drop_constraint("order_commission_payer_valid", type_="check")
        batch.drop_constraint("order_commission_mode_valid", type_="check")
