"""add_required_when_to_order_form_fields：字段必填态三态化（必填/条件必填/选填）。

背景：设置页把字段改「选填」后表单仍强制必填（`resolveRules` 必填下限语义），
用户裁决「所有表单都跟设置同步」，并要求支持条件必填。

模型：不改既有 `required` 布尔语义，另加可空 JSON 列 `required_when`
``{"field": 依赖字段键, "op": "eq|ne|filled", "values": [触发值]}``：

- ``required = 1`` → 必填（``required_when`` 被清空，二者互斥）；
- ``required = 0`` 且 ``required_when`` 为空 → 选填；
- ``required = 0`` 且 ``required_when`` 非空 → 条件必填。

三态用「布尔 + 可空条件」表达，避免新增 CHECK 枚举触发 SQLite 整表重建。

Revision ID: 15b7c8d9e0f1
Revises: 14bcd3e5f6a7
Create Date: 2026-10-26 22:40:00.000000

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "15b7c8d9e0f1"
down_revision: str | None = "14bcd3e5f6a7"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "order_form_fields"

# 原前端硬编码的条件必填规则转正为配置种子（否则「选填」终局语义会让这些字段失去条件必填）：
# - 来源选「其他」时，「其他来源」必填；
# - 填了中介费时，「经手平台 / 中介类型」必填；
# - 中介类型选「包赔」时，「包赔类型」必填。
CONDITION_SEEDS: list[tuple[str, str, dict]] = [
    ("HS", "customer_source_other", {"field": "customer_source", "op": "eq", "values": ["其他"]}),
    ("TH", "supplier_source_other", {"field": "supplier_source", "op": "eq", "values": ["其他"]}),
    ("DG", "dg_customer_source_other", {"field": "dg_customer_source", "op": "eq", "values": ["其他"]}),
    ("HS", "intermediary_platform", {"field": "intermediary_fee", "op": "filled", "values": None}),
    ("HS", "intermediary_type", {"field": "intermediary_fee", "op": "filled", "values": None}),
    ("HS", "compensation_type", {"field": "intermediary_type", "op": "eq", "values": ["包赔"]}),
    ("TH", "intermediary_platform", {"field": "intermediary_fee", "op": "filled", "values": None}),
    ("TH", "intermediary_type", {"field": "intermediary_fee", "op": "filled", "values": None}),
    ("TH", "compensation_type", {"field": "intermediary_type", "op": "eq", "values": ["包赔"]}),
]


def _seed_conditions() -> None:
    """仅对「尚未配置条件且未设必填」的行写入种子条件，保证可重复执行。"""
    tbl = sa.table(
        TABLE,
        sa.column("order_type_code", sa.String),
        sa.column("field_key", sa.String),
        sa.column("required", sa.Boolean),
        sa.column("required_when", sa.JSON),
    )
    for code, key, condition in CONDITION_SEEDS:
        op_stmt = (
            tbl.update()
            .where(tbl.c.order_type_code == code)
            .where(tbl.c.field_key == key)
            .where(tbl.c.required.is_(False))
            .where(tbl.c.required_when.is_(None))
            .values(required_when=condition)
        )
        op.execute(op_stmt)


def upgrade() -> None:
    columns = {col["name"] for col in sa.inspect(op.get_bind()).get_columns(TABLE)}
    if "required_when" not in columns:
        op.add_column(TABLE, sa.Column("required_when", sa.JSON(), nullable=True))
    _seed_conditions()


def downgrade() -> None:
    # SQLite 上不删列：0002~0014 的种子迁移用 ORM 读 order_form_fields，
    # 删掉 required_when 会让这些低版本迁移在回放/降级时因缺列而报错。
    # 本列为可空增量列，旧版本代码忽略它，保留即可安全降级。
    return
