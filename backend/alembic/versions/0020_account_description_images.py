"""为库存账号增加描述与图片资料。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0020_account_description_images"
down_revision = "0019_account_drop_pending"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.add_column(sa.Column("account_description", sa.Text(), nullable=True))
        batch.add_column(sa.Column("account_images", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.drop_column("account_images")
        batch.drop_column("account_description")
