"""enforce reconciliation and installment schedule calculations"""
from __future__ import annotations

from alembic import op


revision = "0052_reconciliation_installment_checks"
down_revision = "0051_user_security_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("reconciliations") as batch:
        batch.create_check_constraint(
            "difference_matches_balances",
            "difference = statement_balance - system_balance",
        )

    with op.batch_alter_table("installment_schedules") as batch:
        batch.create_check_constraint(
            "settled_amount_within_due",
            "received_amount + waived_amount <= due_amount",
        )


def downgrade() -> None:
    with op.batch_alter_table("installment_schedules") as batch:
        batch.drop_constraint("settled_amount_within_due", type_="check")

    with op.batch_alter_table("reconciliations") as batch:
        batch.drop_constraint("difference_matches_balances", type_="check")
