"""保存代挂订单的结算条款。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "0036_add_dg_settlement_terms"
down_revision = "0035_add_internal_cashflow_nature"
branch_labels = None
depends_on = None


def upgrade() -> None:
    existing = {column["name"] for column in inspect(op.get_bind()).get_columns("orders")}
    columns = (
        sa.Column("listing_price", sa.Numeric(18, 2), nullable=True),
        sa.Column("service_fee", sa.Numeric(18, 2), nullable=True),
        sa.Column("commission_mode", sa.String(length=32), nullable=True),
        sa.Column("commission_payer", sa.String(length=16), nullable=True),
        sa.Column("expected_settlement_date", sa.Date(), nullable=True),
    )
    with op.batch_alter_table("orders") as batch:
        for column in columns:
            if column.name not in existing:
                batch.add_column(column)


def downgrade() -> None:
    existing = {column["name"] for column in inspect(op.get_bind()).get_columns("orders")}
    with op.batch_alter_table("orders") as batch:
        for name in (
            "expected_settlement_date",
            "commission_payer",
            "commission_mode",
            "service_fee",
            "listing_price",
        ):
            if name in existing:
                batch.drop_column(name)
