"""为现有 v1 数据库补充统一的入库时间。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("stocks")}
    if "inventory_entry_at" not in columns:
        op.add_column(
            "stocks",
            sa.Column("inventory_entry_at", sa.DateTime(), nullable=True),
        )

    # 历史记录没有独立的入库时间，使用账号建档时间作为可追溯回填值，精确到秒。
    if bind.dialect.name == "postgresql":
        bind.execute(
            sa.text(
                "UPDATE stocks "
                "SET inventory_entry_at = date_trunc('second', created_at) "
                "WHERE inventory_entry_at IS NULL"
            )
        )
    else:
        bind.execute(
            sa.text(
                "UPDATE stocks SET inventory_entry_at = datetime(created_at) "
                "WHERE inventory_entry_at IS NULL"
            )
        )

    with op.batch_alter_table("stocks") as batch_op:
        batch_op.alter_column(
            "inventory_entry_at",
            existing_type=sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("stocks")}
    if "inventory_entry_at" in columns:
        with op.batch_alter_table("stocks") as batch_op:
            batch_op.drop_column("inventory_entry_at")
