"""add installment waiver amounts

Revision ID: 0043_installment_waivers
Revises: 0042_deposit_loss
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0043_installment_waivers"
down_revision = "0042_deposit_loss"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("installments") as batch:
        batch.add_column(
            sa.Column("waived_amount", sa.Numeric(18, 2), nullable=False, server_default="0")
        )
    with op.batch_alter_table("installment_schedules") as batch:
        batch.add_column(
            sa.Column("waived_amount", sa.Numeric(18, 2), nullable=False, server_default="0")
        )
    with op.batch_alter_table("installments") as batch:
        batch.drop_constraint("amount_nonneg", type_="check")
        batch.create_check_constraint(
            "amount_nonneg",
            "principal >= 0 AND down_payment >= 0 AND service_fee >= 0 "
            "AND per_period_service_fee >= 0 AND per_period >= 0 "
            "AND paid_amount >= 0 AND waived_amount >= 0",
        )
    with op.batch_alter_table("installment_schedules") as batch:
        batch.drop_constraint("amount_nonneg", type_="check")
        batch.create_check_constraint(
            "amount_nonneg",
            "due_amount >= 0 AND received_amount >= 0 AND waived_amount >= 0",
        )


def downgrade() -> None:
    with op.batch_alter_table("installments") as batch:
        batch.drop_constraint("amount_nonneg", type_="check")
        batch.create_check_constraint(
            "amount_nonneg",
            # 0042 的真实历史约束尚未把 0015 新增服务费列纳入 CHECK；
            # 回退必须恢复这个确切口径，后续 0015 才能安全删除服务费列。
            "principal >= 0 AND down_payment >= 0 AND per_period >= 0 "
            "AND paid_amount >= 0",
        )
    with op.batch_alter_table("installment_schedules") as batch:
        batch.drop_constraint("amount_nonneg", type_="check")
        batch.create_check_constraint(
            "amount_nonneg", "due_amount >= 0 AND received_amount >= 0"
        )
    with op.batch_alter_table("installment_schedules") as batch:
        batch.drop_column("waived_amount")
    with op.batch_alter_table("installments") as batch:
        batch.drop_column("waived_amount")
