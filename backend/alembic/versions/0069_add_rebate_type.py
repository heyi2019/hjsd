"""区分返点买入侧与售出侧，支持同一订单多方向返点。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0069_add_rebate_type"
down_revision = "0068_remove_legacy_account_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("rebate_records") as batch:
        batch.add_column(sa.Column("rebate_type", sa.String(length=16), nullable=True))

    bind = op.get_bind()
    unknown = bind.execute(
        sa.text(
            "SELECT COUNT(*) FROM rebate_records "
            "WHERE rebate_type IS NULL "
            "AND (channel IS NULL OR channel NOT IN ('买号返点', '卖号返点'))"
        )
    ).scalar_one()
    if unknown:
        raise RuntimeError(
            "0069 无法为返点记录确定 BUY/SELL 类型；请先完成标准化数据整理"
        )
    bind.execute(
        sa.text(
            "UPDATE rebate_records "
            "SET rebate_type = CASE "
            "WHEN channel = '买号返点' THEN 'BUY' "
            "WHEN channel = '卖号返点' THEN 'SELL' "
            "ELSE NULL END "
            "WHERE rebate_type IS NULL"
        )
    )

    with op.batch_alter_table("rebate_records") as batch:
        batch.alter_column("rebate_type", existing_type=sa.String(length=16), nullable=False)
        batch.create_check_constraint(
            "rebate_type_valid",
            "rebate_type IN ('BUY', 'SELL')",
        )


def downgrade() -> None:
    with op.batch_alter_table("rebate_records") as batch:
        batch.drop_constraint("rebate_type_valid", type_="check")
        batch.drop_column("rebate_type")
