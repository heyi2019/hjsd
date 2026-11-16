"""Store selected operators on cashflows.

Revision ID: 0003
Revises: 0002
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "0003"
down_revision: str | None = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("cashflow")}
    if "operator_user_ids" not in columns:
        op.add_column("cashflow", sa.Column("operator_user_ids", sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("cashflow")}
    if "operator_user_ids" in columns:
        op.drop_column("cashflow", "operator_user_ids")
