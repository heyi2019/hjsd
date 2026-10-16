"""enforce account business mode and inventory type semantics"""
from __future__ import annotations

from alembic import op


revision = "0064_account_context_checks"
down_revision = "0063_extra_value_entity_check"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.create_check_constraint(
            "account_business_mode_valid",
            "business_mode IS NULL OR business_mode IN ('SELF', 'DISTRIBUTION')",
        )
        batch.create_check_constraint(
            "account_inventory_type_valid",
            "inventory_type IS NULL OR inventory_type IN ('RECOVERY', 'PICKUP', 'CONSIGNMENT')",
        )
        batch.create_check_constraint(
            "account_inventory_context_valid",
            "business_mode IS NULL OR inventory_type IS NULL OR "
            "(business_mode = 'SELF' AND inventory_type = 'RECOVERY') OR "
            "(business_mode = 'DISTRIBUTION' AND inventory_type IN ('PICKUP', 'CONSIGNMENT'))",
        )


def downgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.drop_constraint("account_inventory_context_valid", type_="check")
        batch.drop_constraint("account_inventory_type_valid", type_="check")
        batch.drop_constraint("account_business_mode_valid", type_="check")
