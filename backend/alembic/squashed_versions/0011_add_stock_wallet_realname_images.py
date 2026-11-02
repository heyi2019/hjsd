"""为库存账号补充「钱包实名图片」列。

业务背景：钱包实名登记为「已注销」时需要凭图确认解绑结果，与二次图片同构
（JSON 数组，最多 3 张 data URL），只作交付资料，不参与任何核算。

存量数据为空，不做回填。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

COLUMN = "wallet_realname_images"


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("stocks")}
    if COLUMN not in columns:
        op.add_column("stocks", sa.Column(COLUMN, sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("stocks")}
    if COLUMN in columns:
        with op.batch_alter_table("stocks") as batch_op:
            batch_op.drop_column(COLUMN)
