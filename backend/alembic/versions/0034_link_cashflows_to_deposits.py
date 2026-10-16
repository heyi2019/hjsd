"""为押金占用与释放流水补充押金外键，支持部分退回的精确追溯。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0034_link_cashflows_to_deposits"
down_revision = "0033_link_cashflows_to_orders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # SQLite 的 batch 重建在 cashflow 已被 rebate_settlements 反向引用时，
    # 会把新增的 deposits 外键错误地纳入列排序，触发 CircularDependencyError。
    # 这里用带内联 REFERENCES 的 ADD COLUMN：SQLite 原生支持，且保留真实外键约束，
    # PostgreSQL 也会生成同名列级外键；不再重建整张 cashflow 表。
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("cashflow")}
    if "deposit_id" not in columns:
        op.add_column(
            "cashflow",
            sa.Column(
                "deposit_id",
                sa.Integer(),
                sa.ForeignKey(
                    "deposits.id",
                    name="fk_cashflow_deposit_id_deposits",
                    ondelete="SET NULL",
                ),
                nullable=True,
            ),
        )
        op.create_index("ix_cashflow_deposit", "cashflow", ["deposit_id"], unique=False)


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "ix_cashflow_deposit" in {index["name"] for index in inspector.get_indexes("cashflow")}:
        op.drop_index("ix_cashflow_deposit", table_name="cashflow")
    if "deposit_id" in {column["name"] for column in inspector.get_columns("cashflow")}:
        # SQLite 需要 batch 才能删除列；此时不再新增外键，不会触发 0034 的循环排序。
        with op.batch_alter_table("cashflow") as batch:
            batch.drop_column("deposit_id")
