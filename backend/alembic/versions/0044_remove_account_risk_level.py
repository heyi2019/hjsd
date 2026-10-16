"""remove account risk level; inventory aging is presentation-only

Revision ID: 0044_remove_account_risk_level
Revises: 0043_installment_waivers
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0044_remove_account_risk_level"
down_revision = "0043_installment_waivers"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.drop_column("risk_level")


def downgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.add_column(sa.Column("risk_level", sa.String(16), nullable=True))
