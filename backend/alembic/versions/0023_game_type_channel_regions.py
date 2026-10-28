"""为游戏类型增加对应的渠道／区服选项。"""
from alembic import op
import sqlalchemy as sa


revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("game_type_options", sa.Column("channel_regions", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("game_type_options", "channel_regions")
