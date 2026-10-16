"""增加回收账号档案字段（2026-10-14）。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0013_account_recovery_fields"
down_revision = "0012_seed_account_merchant_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.add_column(sa.Column("game_type", sa.String(length=64), nullable=True))
        batch.add_column(sa.Column("game_password", sa.String(length=256), nullable=True))
        batch.add_column(sa.Column("channel_region", sa.String(length=128), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.drop_column("channel_region")
        batch.drop_column("game_password")
        batch.drop_column("game_type")
