"""enforce policy definition scope invariants"""
from __future__ import annotations

from alembic import op


revision = "0058_policy_scope_checks"
down_revision = "0057_foundation_ordering_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("policy_definitions") as batch:
        batch.create_check_constraint(
            "policy_scope_type_valid",
            "scope_type IN ('GLOBAL', 'ORDER_TYPE', 'USER', 'POOL')",
        )
        batch.create_check_constraint(
            "policy_scope_link_valid",
            "(scope_type = 'GLOBAL' AND scope_id IS NULL) OR "
            "(scope_type <> 'GLOBAL' AND scope_id IS NOT NULL)",
        )


def downgrade() -> None:
    with op.batch_alter_table("policy_definitions") as batch:
        batch.drop_constraint("policy_scope_link_valid", type_="check")
        batch.drop_constraint("policy_scope_type_valid", type_="check")
