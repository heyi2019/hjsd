"""记录返点业务操作人（支持多选）。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0058_add_rebate_operator_user_ids"
down_revision = "0057_update_refund_cashflow_form_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("rebate_records", sa.Column("operator_user_ids", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("rebate_records", "operator_user_ids")
