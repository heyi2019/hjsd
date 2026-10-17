"""add database timestamp defaults to installment dispositions

Revision ID: 0023
Revises: 0022
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("installment_dispositions", schema=None) as batch_op:
        batch_op.alter_column(
            "created_at",
            existing_type=sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            existing_nullable=False,
        )
        batch_op.alter_column(
            "updated_at",
            existing_type=sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            existing_nullable=False,
        )


def downgrade() -> None:
    with op.batch_alter_table("installment_dispositions", schema=None) as batch_op:
        batch_op.alter_column(
            "created_at",
            existing_type=sa.DateTime(),
            server_default=None,
            existing_nullable=False,
        )
        batch_op.alter_column(
            "updated_at",
            existing_type=sa.DateTime(),
            server_default=None,
            existing_nullable=False,
        )
