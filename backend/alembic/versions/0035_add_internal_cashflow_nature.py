"""允许资金池间成对划转使用 INTERNAL 现金流性质。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0035_add_internal_cashflow_nature"
down_revision = "0034_link_cashflows_to_deposits"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("cashflow") as batch:
        batch.drop_constraint("cashflow_nature_valid", type_="check")
        batch.create_check_constraint(
            "cashflow_nature_valid",
            "nature IN ('EXTERNAL_IN', 'BUSINESS_IN', 'BUSINESS_OUT', 'INTERNAL')",
        )


def downgrade() -> None:
    connection = op.get_bind()
    if connection.execute(sa.text("SELECT COUNT(*) FROM cashflow WHERE nature = 'INTERNAL'")).scalar():
        raise RuntimeError("无法回滚：cashflow 中仍存在 INTERNAL 划转流水")
    with op.batch_alter_table("cashflow") as batch:
        batch.drop_constraint("cashflow_nature_valid", type_="check")
        batch.create_check_constraint(
            "cashflow_nature_valid",
            "nature IN ('EXTERNAL_IN', 'BUSINESS_IN', 'BUSINESS_OUT')",
        )
