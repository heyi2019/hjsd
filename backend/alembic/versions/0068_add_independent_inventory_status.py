"""为账号增加独立的在库/出库状态，分离订单与分期状态。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0068_add_independent_inventory_status"
down_revision = "0067_drop_period_locks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "stocks",
        sa.Column(
            "inventory_status",
            sa.String(length=16),
            nullable=False,
            server_default="IN_STOCK",
        ),
    )
    op.execute(
        sa.text(
            "UPDATE stocks SET inventory_status = "
            "CASE WHEN status = 'IN_STOCK' THEN 'IN_STOCK' "
            "ELSE 'OUT_OF_STOCK' END"
        )
    )
    # 保留默认值兼容 SQLite 的历史迁移路径；ORM 在账号状态变化时会显式同步该字段。
    with op.batch_alter_table("stocks") as batch_op:
        batch_op.create_check_constraint(
            "account_inventory_status_valid",
            "inventory_status IN ('IN_STOCK', 'OUT_OF_STOCK')",
        )


def downgrade() -> None:
    with op.batch_alter_table("stocks") as batch_op:
        batch_op.drop_constraint("account_inventory_status_valid", type_="check")
        batch_op.drop_column("inventory_status")
