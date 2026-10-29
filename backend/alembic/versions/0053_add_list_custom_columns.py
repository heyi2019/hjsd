"""列表字段新增自定义列定义表。

管理员可在「设置 → 列表字段」为任一列表新增一列，列绑定一个表单自定义字段
（field_key），值从行数据 form_extra / extra_values 取。显示状态仍复用
list_column_configs，列键加 `extra:` 前缀与注册表内置列隔离。
只建表不播种。
"""

import sqlalchemy as sa
from alembic import op

revision = "0053_add_list_custom_columns"
down_revision = "0052_add_list_column_width_fixed"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "list_custom_columns",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("scope", sa.String(length=32), nullable=False),
        sa.Column("column_key", sa.String(length=80), nullable=False),
        sa.Column("label", sa.String(length=64), nullable=False),
        sa.Column("source_key", sa.String(length=64), nullable=False),
        sa.Column("field_type", sa.String(length=16), nullable=False, server_default="TEXT"),
        sa.Column("value_labels", sa.JSON(), nullable=True),
        sa.Column("created_by", sa.String(length=64), nullable=False, server_default="system"),
        sa.Column("updated_by", sa.String(length=64), nullable=False, server_default="system"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("scope", "column_key", name="uq_list_custom_columns_scope_column"),
    )


def downgrade() -> None:
    op.drop_table("list_custom_columns")
