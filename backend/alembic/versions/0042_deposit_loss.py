"""track deposit losses as operating expense

Revision ID: 0042_deposit_loss
Revises: 0041_daily_reconciliation
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0042_deposit_loss"
down_revision = "0041_daily_reconciliation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("deposits") as batch:
        batch.add_column(
            sa.Column("lost_amount", sa.Numeric(18, 2), nullable=False, server_default="0")
        )
        batch.add_column(sa.Column("lost_on", sa.Date(), nullable=True))

    with op.batch_alter_table("deposits") as batch:
        batch.drop_constraint("deposit_status_valid", type_="check")
        batch.create_check_constraint(
            "deposit_status_valid",
            "status IN ('PAID', 'PARTIALLY_RETURNED', 'RETURNED', 'LOST', 'CANCELLED')",
        )


def downgrade() -> None:
    with op.batch_alter_table("deposits") as batch:
        batch.drop_constraint("deposit_status_valid", type_="check")
        batch.create_check_constraint(
            "deposit_status_valid",
            "status IN ('PAID', 'PARTIALLY_RETURNED', 'RETURNED', 'CANCELLED')",
        )

    with op.batch_alter_table("deposits") as batch:
        batch.drop_column("lost_on")
        batch.drop_column("lost_amount")
