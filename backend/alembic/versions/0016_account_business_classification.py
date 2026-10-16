"""为库存账号记录业务归属与入库类型。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0016_account_business_classification"
down_revision = "0015_installment_service_fee"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.add_column(sa.Column("business_mode", sa.String(length=24), nullable=True))
        batch.add_column(sa.Column("inventory_type", sa.String(length=24), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.drop_column("inventory_type")
        batch.drop_column("business_mode")
