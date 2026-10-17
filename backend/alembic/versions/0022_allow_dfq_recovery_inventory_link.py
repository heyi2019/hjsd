"""allow DFQ orders to link a materialized recovery inventory account

Revision ID: 0022
Revises: 0021
"""
from __future__ import annotations

from alembic import op


revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("orders", schema=None) as batch_op:
        batch_op.drop_constraint("order_account_link_type_valid", type_="check")


def downgrade() -> None:
    with op.batch_alter_table("orders", schema=None) as batch_op:
        batch_op.create_check_constraint(
            "order_account_link_type_valid",
            "order_type != 'DFQ' OR account_id IS NULL",
        )
