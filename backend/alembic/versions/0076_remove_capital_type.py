"""删除订单类型与订单上的 capital_type 字段。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0076_remove_capital_type"
down_revision = "0075_remove_fund_nature"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("DELETE FROM option_sets WHERE code = 'CAPITAL_TYPE'"))

    with op.batch_alter_table("order_type_defs", recreate="always") as batch:
        batch.drop_constraint("capital_type_valid", type_="check")
        batch.drop_column("capital_type")

    with op.batch_alter_table("orders", recreate="always") as batch:
        batch.drop_constraint("order_capital_type_valid", type_="check")
        batch.drop_column("capital_type")


def downgrade() -> None:
    raise RuntimeError("capital_type 已按业务决策删除，不支持回滚")
