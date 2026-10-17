"""allow recovered installment contracts to be closed

Revision ID: 0019
Revises: 0018
"""
from __future__ import annotations

from alembic import op


revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("installments", schema=None) as batch_op:
        batch_op.drop_constraint(
            op.f("ck_installments_installment_status_valid"), type_="check"
        )
        batch_op.create_check_constraint(
            op.f("ck_installments_installment_status_valid"),
            "status IN ('PENDING', 'ACTIVE', 'OVERDUE', 'SETTLED', 'DELIVERED', 'DEFAULTED', 'CLOSED', 'CANCELLED')",
        )


def downgrade() -> None:
    with op.batch_alter_table("installments", schema=None) as batch_op:
        batch_op.drop_constraint(
            op.f("ck_installments_installment_status_valid"), type_="check"
        )
        batch_op.create_check_constraint(
            op.f("ck_installments_installment_status_valid"),
            "status IN ('PENDING', 'ACTIVE', 'OVERDUE', 'SETTLED', 'DELIVERED', 'DEFAULTED', 'CANCELLED')",
        )
