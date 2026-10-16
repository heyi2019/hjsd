"""为押金占用与释放流水补充押金外键，支持部分退回的精确追溯。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0034_link_cashflows_to_deposits"
down_revision = "0033_link_cashflows_to_orders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("cashflow") as batch:
        batch.add_column(sa.Column("deposit_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_cashflow_deposit_id_deposits",
            "deposits",
            ["deposit_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_index("ix_cashflow_deposit", ["deposit_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("cashflow") as batch:
        batch.drop_index("ix_cashflow_deposit")
        batch.drop_constraint("fk_cashflow_deposit_id_deposits", type_="foreignkey")
        batch.drop_column("deposit_id")
