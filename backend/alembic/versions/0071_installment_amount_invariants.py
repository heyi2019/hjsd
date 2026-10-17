"""为分期合同补齐首付、本金与计划总额的数据库约束。"""
from __future__ import annotations

from alembic import op


revision = "0071_installment_amount_invariants"
down_revision = "0070_remove_unspecified_rebate_type"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("installments") as batch:
        batch.create_check_constraint(
            "down_payment_lte_principal",
            "down_payment <= principal",
        )
        batch.create_check_constraint(
            "principal_lte_schedule_total",
            "principal <= down_payment + per_period * periods",
        )


def downgrade() -> None:
    with op.batch_alter_table("installments") as batch:
        batch.drop_constraint("principal_lte_schedule_total", type_="check")
        batch.drop_constraint("down_payment_lte_principal", type_="check")
