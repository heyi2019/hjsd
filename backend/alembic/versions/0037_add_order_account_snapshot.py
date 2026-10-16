"""保存 DFQ 订单内的账号文本快照，不关联库存账号。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "0037_add_order_account_snapshot"
down_revision = "0036_add_dg_settlement_terms"
branch_labels = None
depends_on = None


def upgrade() -> None:
    existing = {column["name"] for column in inspect(op.get_bind()).get_columns("orders")}
    if "account_snapshot" not in existing:
        with op.batch_alter_table("orders") as batch:
            batch.add_column(sa.Column("account_snapshot", sa.JSON(), nullable=True))


def downgrade() -> None:
    existing = {column["name"] for column in inspect(op.get_bind()).get_columns("orders")}
    if "account_snapshot" in existing:
        with op.batch_alter_table("orders") as batch:
            batch.drop_column("account_snapshot")
