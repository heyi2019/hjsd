"""Persist inline game-account fields on orders as separate columns.

HS / TH / DG 内联填写的游戏账号资料（库存编号由库存中心建档时自动生成），
逐个字段独立落库，不再依赖 account_snapshot（非 DFQ 的 account_snapshot 必须为 NULL）。
"""
from alembic import op
import sqlalchemy as sa

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("orders") as batch:
        batch.add_column(sa.Column("game_type", sa.String(64), nullable=True))
        batch.add_column(sa.Column("game_account", sa.String(128), nullable=True))
        batch.add_column(sa.Column("game_password", sa.String(256), nullable=True))
        batch.add_column(sa.Column("channel_region", sa.String(128), nullable=True))
        batch.add_column(sa.Column("bound_phone", sa.String(64), nullable=True))
        batch.add_column(sa.Column("has_secondary", sa.Boolean(), nullable=True))
        batch.add_column(sa.Column("account_note", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("orders") as batch:
        batch.drop_column("account_note")
        batch.drop_column("has_secondary")
        batch.drop_column("bound_phone")
        batch.drop_column("channel_region")
        batch.drop_column("game_password")
        batch.drop_column("game_account")
        batch.drop_column("game_type")
