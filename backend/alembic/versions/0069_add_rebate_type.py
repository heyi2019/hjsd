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
    bind.execute(
        sa.text(
            "UPDATE rebate_records "
            "SET rebate_type = CASE "
            "WHEN channel = '买号返点' THEN 'BUY' "
            "WHEN channel = '卖号返点' THEN 'SELL' "
            "ELSE 'UNSPECIFIED' END "
            "WHERE rebate_type IS NULL"
        )
    )

    with op.batch_alter_table("rebate_records") as batch:
        batch.alter_column("rebate_type", existing_type=sa.String(length=16), nullable=False)
        batch.create_check_constraint(
            "rebate_type_valid",
            "rebate_type IN ('BUY', 'SELL', 'UNSPECIFIED')",
        )


def downgrade() -> None:
    with op.batch_alter_table("rebate_records") as batch:
        batch.drop_constraint("rebate_type_valid", type_="check")
        batch.drop_column("rebate_type")
