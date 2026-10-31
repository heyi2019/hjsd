"""列表列配置增加列宽与固定列（width / fixed）。

只加列不播种：NULL 表示不覆盖，沿用前端列定义自身的宽度与不固定状态，
因此老配置与新增列都不需要数据迁移。
"""

import sqlalchemy as sa
from alembic import op

revision = "0052_add_list_column_width_fixed"
down_revision = "0051_add_list_column_configs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("list_column_configs", sa.Column("width", sa.Integer(), nullable=True))
    op.add_column("list_column_configs", sa.Column("fixed", sa.String(length=8), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("list_column_configs") as batch:
        batch.drop_column("fixed")
        batch.drop_column("width")

