"""移除账号表未使用的 region / channels 遗留字段。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0068_remove_legacy_account_fields"
down_revision = "0067_sequence_bounds"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    legacy_rows = bind.execute(
        sa.text(
            "SELECT COUNT(*) FROM accounts "
            "WHERE region IS NOT NULL OR channels IS NOT NULL"
        )
    ).scalar_one()
    if legacy_rows:
        raise RuntimeError(
            "accounts.region/channels 仍有数据，未执行删除；请先完成显式数据迁移"
        )

    with op.batch_alter_table("accounts") as batch:
        batch.drop_column("channels")
        batch.drop_column("region")


def downgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.add_column(sa.Column("region", sa.String(length=64), nullable=True))
        batch.add_column(sa.Column("channels", sa.JSON(), nullable=True))
