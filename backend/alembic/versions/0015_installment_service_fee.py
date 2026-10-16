"""记录分期服务费总额与每期服务费。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0015_installment_service_fee"
down_revision = "0014_account_secondary_flag"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("installments") as batch:
        batch.add_column(sa.Column("service_fee", sa.Numeric(18, 2), nullable=False, server_default="0"))
        batch.add_column(sa.Column("per_period_service_fee", sa.Numeric(18, 2), nullable=False, server_default="0"))


def downgrade() -> None:
    with op.batch_alter_table("installments") as batch:
        batch.drop_column("per_period_service_fee")
        batch.drop_column("service_fee")
