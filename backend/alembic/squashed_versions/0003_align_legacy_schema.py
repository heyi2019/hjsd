"""补齐压平前测试库遗留的三列，确保现有库与 ORM 基线一致。"""
from __future__ import annotations

from alembic import op


revision = "0003_align_legacy_schema"
down_revision = "0002_action_model"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 这些列在当前 ORM 基线中均为必填；先允许空列回填，再收紧约束，兼容
    # 已存在的 dev/test 库，不删除任何历史数据。
    op.execute("ALTER TABLE order_type_defs ADD COLUMN IF NOT EXISTS capital_type VARCHAR(16)")
    op.execute(
        """
        UPDATE order_type_defs
        SET capital_type = CASE WHEN code = 'DG' THEN 'ZERO' ELSE 'STOCK' END
        WHERE capital_type IS NULL
        """
    )
    op.execute("ALTER TABLE order_type_defs ALTER COLUMN capital_type SET NOT NULL")

    op.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS capital_type VARCHAR(16)")
    op.execute(
        """
        UPDATE orders
        SET capital_type = CASE WHEN order_type = 'DG' THEN 'ZERO' ELSE 'STOCK' END
        WHERE capital_type IS NULL
        """
    )
    op.execute("ALTER TABLE orders ALTER COLUMN capital_type SET NOT NULL")

    op.execute("ALTER TABLE cashflow ADD COLUMN IF NOT EXISTS nature VARCHAR(32)")
    op.execute(
        "UPDATE cashflow SET nature = CASE WHEN direction = 'IN' THEN 'BUSINESS_IN' ELSE 'BUSINESS_OUT' END WHERE nature IS NULL"
    )
    op.execute("ALTER TABLE cashflow ALTER COLUMN nature SET NOT NULL")


def downgrade() -> None:
    # 仅撤销本迁移添加的兼容列；不在生产运行中执行 downgrade，避免破坏当前基线。
    op.execute("ALTER TABLE cashflow DROP COLUMN IF EXISTS nature")
    op.execute("ALTER TABLE orders DROP COLUMN IF EXISTS capital_type")
    op.execute("ALTER TABLE order_type_defs DROP COLUMN IF EXISTS capital_type")
