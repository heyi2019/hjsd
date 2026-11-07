"""删除与收支方向重复的现金流 nature 字段。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0077_remove_cashflow_nature"
down_revision = "0076_remove_capital_type"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("DELETE FROM option_sets WHERE code = 'CASHFLOW_NATURE'"))
    # 当前资金明细只保留“收入/支出”两类核算属性；将存量旧枚举按收支方向归一化，
    # 再重建 CHECK，避免历史库在删除 nature 后仍接受已下线的资金属性。
    bind.execute(
        sa.text(
            "UPDATE cashflow SET accounting_attribute = "
            "CASE WHEN direction = 'IN' THEN 'INCOME' ELSE 'EXPENSE' END "
            "WHERE accounting_attribute NOT IN ('INCOME', 'EXPENSE')"
        )
    )
    bind.execute(
        sa.text(
            "ALTER TABLE cashflow DROP CONSTRAINT IF EXISTS "
            "ck_cashflow_cashflow_accounting_attribute_valid"
        )
    )
    bind.execute(
        sa.text(
            "ALTER TABLE cashflow DROP CONSTRAINT IF EXISTS "
            "cashflow_accounting_attribute_valid"
        )
    )
    with op.batch_alter_table("cashflow", recreate="always") as batch:
        batch.drop_index("ix_cashflow_nature")
        batch.drop_constraint("cashflow_nature_valid", type_="check")
        batch.drop_constraint("internal_transfer_link_valid", type_="check")
        batch.drop_constraint("cashflow_direction_nature_valid", type_="check")
        batch.drop_column("nature")
    bind.execute(
        sa.text(
            "ALTER TABLE cashflow ADD CONSTRAINT "
            "ck_cashflow_cashflow_accounting_attribute_valid "
            "CHECK (accounting_attribute IN ('INCOME', 'EXPENSE'))"
        )
    )


def downgrade() -> None:
    raise RuntimeError("资金流向性质已按业务决策删除，不支持回滚")
