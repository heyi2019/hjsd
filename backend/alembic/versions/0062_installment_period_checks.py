"""enforce nonnegative installment schedule period numbers"""
from __future__ import annotations

from alembic import op


revision = "0062_installment_period_checks"
down_revision = "0061_link_status_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("installment_schedules") as batch:
        batch.create_check_constraint(
            "period_no_nonnegative",
            "period_no >= 0",
        )


def downgrade() -> None:
    with op.batch_alter_table("installment_schedules") as batch:
        batch.drop_constraint("period_no_nonnegative", type_="check")
