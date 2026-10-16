"""enforce policy version and counterparty role invariants"""
from __future__ import annotations

from alembic import op


revision = "0055_policy_and_counterparty_checks"
down_revision = "0054_rebate_reversal_fk"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("policy_versions") as batch:
        batch.create_check_constraint(
            "policy_version_status_valid",
            "status IN ('DRAFT', 'ACTIVE', 'EXPIRED', 'SUPERSEDED')",
        )
        batch.create_check_constraint("version_positive", "version > 0")
        batch.create_check_constraint(
            "effective_range_valid",
            "effective_to IS NULL OR effective_to > effective_from",
        )

    with op.batch_alter_table("order_counterparty_roles") as batch:
        batch.create_check_constraint(
            "counterparty_role_valid",
            "role IN ('PEER', 'SUPPLIER', 'PLATFORM')",
        )


def downgrade() -> None:
    with op.batch_alter_table("order_counterparty_roles") as batch:
        batch.drop_constraint("counterparty_role_valid", type_="check")

    with op.batch_alter_table("policy_versions") as batch:
        batch.drop_constraint("effective_range_valid", type_="check")
        batch.drop_constraint("version_positive", type_="check")
        batch.drop_constraint("policy_version_status_valid", type_="check")
