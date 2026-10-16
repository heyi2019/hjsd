"""返点结算支持反向结算更正。

Revision ID: 0040_rebate_settlement_reversal
Revises: 0039_cashflow_lifecycle
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0040_rebate_settlement_reversal"
down_revision = "0039_cashflow_lifecycle"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # SQLite 原生 ADD COLUMN 可以安全追加自引用外键；用批量重建会让
    # Alembic 在自引用列上进行拓扑排序并触发循环依赖。
    op.add_column(
        "rebate_settlements",
        sa.Column(
            "reversal_of_id",
            sa.Integer(),
            nullable=True,
        )
    )
    op.create_index(
        "uq_rebate_settlements_reversal",
        "rebate_settlements",
        ["reversal_of_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_rebate_settlements_reversal", table_name="rebate_settlements")
    op.drop_column("rebate_settlements", "reversal_of_id")
