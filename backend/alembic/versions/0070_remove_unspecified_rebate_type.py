"""返点类型收敛为明确的买号返点或卖号返点。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0070_remove_unspecified_rebate_type"
down_revision = "0069_add_rebate_type"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    invalid = bind.execute(
        sa.text(
            "SELECT COUNT(*) FROM rebate_records "
            "WHERE rebate_type IS NULL OR rebate_type NOT IN ('BUY', 'SELL')"
        )
    ).scalar_one()
    if invalid:
        raise RuntimeError(
            "0070 检测到未明确类型的返点记录；请先完成标准化数据整理"
        )
    with op.batch_alter_table("rebate_records") as batch:
        batch.drop_constraint("rebate_type_valid", type_="check")
        batch.create_check_constraint(
            "rebate_type_valid",
            "rebate_type IN ('BUY', 'SELL')",
        )


def downgrade() -> None:
    with op.batch_alter_table("rebate_records") as batch:
        batch.drop_constraint("rebate_type_valid", type_="check")
        batch.create_check_constraint(
            "rebate_type_valid",
            "rebate_type IN ('BUY', 'SELL', 'UNSPECIFIED')",
        )
