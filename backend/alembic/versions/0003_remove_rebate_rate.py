"""Remove the obsolete rebate rate column.

Revision ID: 0003
Revises: 0002
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "0003"
down_revision: str | None = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("rebate_records")}
    if "rate" not in columns:
        return
    with op.batch_alter_table("rebate_records") as batch_op:
        checks = sa.inspect(bind).get_check_constraints("rebate_records")
        if any(check.get("name") == "amount_nonneg" for check in checks):
            batch_op.drop_constraint("amount_nonneg", type_="check")
        if any(check.get("name") == "rate_max" for check in checks):
            batch_op.drop_constraint("rate_max", type_="check")
        batch_op.drop_column("rate")
        batch_op.create_check_constraint("amount_nonneg", "amount >= 0")


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("rebate_records")}
    if "rate" in columns:
        return
    with op.batch_alter_table("rebate_records") as batch_op:
        batch_op.add_column(
            sa.Column("rate", sa.Numeric(18, 2), nullable=False, server_default="0")
        )
        checks = sa.inspect(bind).get_check_constraints("rebate_records")
        if any(check.get("name") == "amount_nonneg" for check in checks):
            batch_op.drop_constraint("amount_nonneg", type_="check")
        batch_op.create_check_constraint("amount_nonneg", "rate >= 0 AND amount >= 0")
        batch_op.create_check_constraint("rate_max", "rate <= 100")
        batch_op.alter_column("rate", server_default=None)
