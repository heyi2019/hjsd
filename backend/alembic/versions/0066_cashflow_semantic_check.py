"""enforce cashflow direction and nature semantics"""
from __future__ import annotations

from alembic import op


revision = "0066_cashflow_semantic_check"
down_revision = "0065_order_semantic_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("cashflow") as batch:
        batch.create_check_constraint(
            "cashflow_direction_nature_valid",
            "(nature = 'INTERNAL' AND transfer_id IS NOT NULL) OR "
            "(direction = 'IN' AND nature IN ('EXTERNAL_IN', 'BUSINESS_IN')) OR "
            "(direction = 'OUT' AND nature = 'BUSINESS_OUT') OR "
            "(category = 'CANCEL' AND nature = 'BUSINESS_IN' AND direction IN ('IN', 'OUT'))",
        )


def downgrade() -> None:
    with op.batch_alter_table("cashflow") as batch:
        batch.drop_constraint("cashflow_direction_nature_valid", type_="check")
