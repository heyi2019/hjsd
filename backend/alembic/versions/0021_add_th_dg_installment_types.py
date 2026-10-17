"""allow TH pickup and DG consignment installment contracts

Revision ID: 0021
Revises: 0020
"""
from __future__ import annotations

from alembic import op


revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("installments", schema=None) as batch_op:
        batch_op.drop_constraint(
            op.f("ck_installments_installment_contract_valid"), type_="check"
        )
        batch_op.create_check_constraint(
            op.f("ck_installments_installment_contract_valid"),
            "contract_type IN ('STOCK_SALE', 'ADVANCE_PURCHASE', 'PICKUP_SALE', 'CONSIGNMENT_SALE')",
        )


def downgrade() -> None:
    with op.batch_alter_table("installments", schema=None) as batch_op:
        batch_op.drop_constraint(
            op.f("ck_installments_installment_contract_valid"), type_="check"
        )
        batch_op.create_check_constraint(
            op.f("ck_installments_installment_contract_valid"),
            "contract_type IN ('STOCK_SALE', 'ADVANCE_PURCHASE')",
        )
