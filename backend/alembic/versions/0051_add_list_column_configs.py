"""新增列表列显示配置表（业务台账 / 库存中心 / 分期与回款）。

只建表不播种：列清单以 `app.lists.scopes` 注册表为准，缺行即默认可见，
因此后续新增列不需要再写数据迁移。
"""

import sqlalchemy as sa
from alembic import op

revision = "0051_add_list_column_configs"
down_revision = "0050_set_order_cancel_incoming_flow"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "list_column_configs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("scope", sa.String(length=32), nullable=False),
        sa.Column("column_key", sa.String(length=64), nullable=False),
        sa.Column("is_visible", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", sa.String(length=64), nullable=False, server_default="system"),
        sa.Column("updated_by", sa.String(length=64), nullable=False, server_default="system"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("scope", "column_key", name="uq_list_column_configs_scope_column"),
    )


def downgrade() -> None:
    op.drop_table("list_column_configs")

