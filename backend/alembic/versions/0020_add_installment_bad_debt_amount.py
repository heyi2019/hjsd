"""track installment bad debt recognized on account recovery

Revision ID: 0020
Revises: 0019
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("installments", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "bad_debt_amount",
                sa.Numeric(precision=18, scale=2),
                nullable=False,
                server_default="0",
            )
        )
        batch_op.drop_constraint(op.f("ck_installments_amount_nonneg"), type_="check")
        batch_op.create_check_constraint(
            op.f("ck_installments_amount_nonneg"),
            "principal >= 0 AND down_payment >= 0 AND service_fee >= 0 AND per_period_service_fee >= 0 AND per_period >= 0 AND paid_amount >= 0 AND waived_amount >= 0 AND bad_debt_amount >= 0",
        )


def downgrade() -> None:
    with op.batch_alter_table("installments", schema=None) as batch_op:
        batch_op.drop_constraint(op.f("ck_installments_amount_nonneg"), type_="check")
        batch_op.create_check_constraint(
            op.f("ck_installments_amount_nonneg"),
            "principal >= 0 AND down_payment >= 0 AND service_fee >= 0 AND per_period_service_fee >= 0 AND per_period >= 0 AND paid_amount >= 0 AND waived_amount >= 0",
        )
        batch_op.drop_column("bad_debt_amount")
