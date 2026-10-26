"""Align the DFQ account-note configuration key with the submitted form value.

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
Create Date: 2026-10-26 21:15:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "f2a3b4c5d6e7"
down_revision = "e1f2a3b4c5d6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE order_form_fields "
            "SET field_key = 'dfq_account_note' "
            "WHERE order_type_code = 'DFQ' AND field_key = 'dfq_game_account_note'"
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE order_form_fields "
            "SET field_key = 'dfq_game_account_note' "
            "WHERE order_type_code = 'DFQ' AND field_key = 'dfq_account_note'"
        )
    )
