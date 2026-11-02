"""为「寄售」操作表单登记「寄售价格」字段配置。

业务背景：库存中心登记寄售（CONSIGN 作用域）时，除平台与上架时间外还需记录
本次挂牌价。价格随该次寄售记录落 orders.form_extra.consignment_price，
属操作快照而非账号档案，因此不做固定列。

字段类型为 NUMBER（展示性挂牌价，不参与成本/利润核算）。幂等：已存在则跳过。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

SCOPE = "CONSIGN"
FIELD_KEY = "consignment_price"
SECTION = "OPERATION"
SORT_ORDER = 1020

_TABLE = sa.table(
    "order_form_fields",
    sa.column("order_type_code", sa.String),
    sa.column("field_key", sa.String),
    sa.column("label", sa.String),
    sa.column("field_type", sa.String),
    sa.column("options", sa.JSON),
    sa.column("required", sa.Boolean),
    sa.column("is_active", sa.Boolean),
    sa.column("sort_order", sa.Integer),
    sa.column("locked", sa.Boolean),
    sa.column("is_custom", sa.Boolean),
    sa.column("section", sa.String),
    sa.column("note", sa.Text),
    sa.column("created_by", sa.String),
    sa.column("updated_by", sa.String),
)


def _exists(bind) -> bool:
    count = bind.execute(
        sa.select(sa.func.count())
        .select_from(_TABLE)
        .where(_TABLE.c.order_type_code == SCOPE)
        .where(_TABLE.c.field_key == FIELD_KEY)
    ).scalar()
    return bool(count)


def upgrade() -> None:
    bind = op.get_bind()
    if _exists(bind):
        return
    bind.execute(
        _TABLE.insert().values(
            order_type_code=SCOPE,
            field_key=FIELD_KEY,
            label="寄售价格",
            field_type="NUMBER",
            options=None,
            required=False,
            is_active=True,
            sort_order=SORT_ORDER,
            locked=False,
            is_custom=False,
            section=SECTION,
            note="本次上架的挂牌价，仅作记录，不参与成本与利润核算",
            created_by="system",
            updated_by="system",
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.delete(_TABLE)
        .where(_TABLE.c.field_key == FIELD_KEY)
        .where(_TABLE.c.order_type_code == SCOPE)
    )
