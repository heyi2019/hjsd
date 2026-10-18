"""add optional fund nature to business-to-pool routes

Revision ID: 0002
Revises: 0001
"""
from __future__ import annotations

from typing import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in inspect(bind).get_columns("order_type_pools")}
    if "fund_nature" in columns:
        return
    with op.batch_alter_table("order_type_pools", schema=None) as batch_op:
        batch_op.add_column(sa.Column("fund_nature", sa.String(length=16), nullable=True))
        batch_op.create_check_constraint(
            "fund_nature_valid",
            "fund_nature IS NULL OR fund_nature IN ('BUSINESS', 'EXTERNAL', 'INTERNAL')",
        )
        batch_op.drop_constraint("uq_order_type_pools_route", type_="unique")
        batch_op.create_unique_constraint(
            "uq_order_type_pools_route",
            ["order_type_id", "portion", "fund_nature"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in inspect(bind).get_columns("order_type_pools")}
    if "fund_nature" not in columns:
        return
    with op.batch_alter_table("order_type_pools", schema=None) as batch_op:
        batch_op.drop_constraint("uq_order_type_pools_route", type_="unique")
        batch_op.drop_constraint("fund_nature_valid", type_="check")
        batch_op.drop_column("fund_nature")
        batch_op.create_unique_constraint(
            "uq_order_type_pools_route",
            ["order_type_id", "portion"],
        )
