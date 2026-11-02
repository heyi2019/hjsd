"""为库存账号补充「钱包实名」状态列。

业务背景：账号交付前需确认游戏钱包实名是否已解绑，属账号安全信息，
不参与任何金额核算，因此以固定列承载（可空），不入活字段。

取值：未注销 / 已注销。由应用层 `stocks._common.validate_wallet_realname` 收敛，
不加数据库 CHECK —— SQLite 降级需整表重建，列级 CHECK 会让重建语句引用已删列而失败。

存量数据与源表同为空，不做回填。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

COLUMN = "wallet_realname"


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("stocks")}
    if COLUMN not in columns:
        op.add_column("stocks", sa.Column(COLUMN, sa.String(16), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("stocks")}
    if COLUMN in columns:
        with op.batch_alter_table("stocks") as batch_op:
            batch_op.drop_column(COLUMN)
