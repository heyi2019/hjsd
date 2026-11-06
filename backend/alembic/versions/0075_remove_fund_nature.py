"""删除资金性质维度，统一按收支方向与核算属性记账。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0075_remove_fund_nature"
down_revision = "0074_seed_business_overview_reminders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()

    # 删除配置层的旧字段与词典，不再允许新表单引用资金性质。
    bind.execute(
        sa.text(
            "DELETE FROM order_form_fields "
            "WHERE order_type_code = 'FUNDFLOW' AND field_key = 'fund_nature'"
        )
    )
    bind.execute(
        sa.text(
            "DELETE FROM option_sets "
            "WHERE code IN ('ROUTE_FUND_NATURE', 'FUND_FLOW_FUND_NATURE')"
        )
    )

    with op.batch_alter_table("cashflow", recreate="always") as batch:
        batch.drop_index("ix_cashflow_fund_nature")
        batch.drop_column("fund_nature")

    with op.batch_alter_table("order_type_pools", recreate="always") as batch:
        batch.drop_constraint("uq_order_type_pools_route", type_="unique")
        batch.drop_constraint("fund_nature_valid", type_="check")
        batch.drop_column("fund_nature")
        batch.create_unique_constraint(
            "uq_order_type_pools_route", ["order_type_id", "portion"]
        )


def downgrade() -> None:
    raise RuntimeError("资金性质已按业务决策删除，不支持回滚")
