"""增加回收账号二次标记（2026-10-14）。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0014_account_secondary_flag"
down_revision = "0013_account_recovery_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.add_column(sa.Column("has_secondary", sa.Boolean(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.drop_column("has_secondary")
