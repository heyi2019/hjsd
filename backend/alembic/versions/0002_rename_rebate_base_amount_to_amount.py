"""Rename rebate amount storage field.

Revision ID: 0002
Revises: 0001
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "0002"
down_revision: str | None = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("rebate_records")}
    if "base_amount" not in columns:
        return
    with op.batch_alter_table("rebate_records") as batch_op:
        checks = sa.inspect(bind).get_check_constraints("rebate_records")
        if any(check.get("name") == "amount_nonneg" for check in checks):
            batch_op.drop_constraint("amount_nonneg", type_="check")
        batch_op.alter_column(
            "base_amount",
            new_column_name="amount",
            existing_type=sa.Numeric(18, 2),
            existing_nullable=False,
        )
        batch_op.create_check_constraint(
            "amount_nonneg", "rate >= 0 AND amount >= 0"
        )


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("rebate_records")}
    if "amount" not in columns:
        return
    with op.batch_alter_table("rebate_records") as batch_op:
        checks = sa.inspect(bind).get_check_constraints("rebate_records")
        if any(check.get("name") == "amount_nonneg" for check in checks):
            batch_op.drop_constraint("amount_nonneg", type_="check")
        batch_op.alter_column(
            "amount",
            new_column_name="base_amount",
            existing_type=sa.Numeric(18, 2),
            existing_nullable=False,
        )
        batch_op.create_check_constraint(
            "amount_nonneg", "rate >= 0 AND base_amount >= 0"
        )
