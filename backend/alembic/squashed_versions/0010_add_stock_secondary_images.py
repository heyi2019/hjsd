"""为库存账号补充「二次图片」列。

业务背景：账号若存在二次验证（微信/QQ/邮箱绑定），交付时需要凭图确认，
因此「有无二次」为「有」时可上传最多 3 张佐证图。图片与账号描述图片同构
（JSON 数组，存 data URL），只作资料留存，不参与任何核算。

存量数据为空，不做回填。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

COLUMN = "secondary_images"


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
