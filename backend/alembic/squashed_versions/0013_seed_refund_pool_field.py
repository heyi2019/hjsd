"""为订单「资金收支」表单登记「资金账户」字段。

业务背景：资金流水里的每一笔支出/收入都必须能指认资金账户，不能只依赖订单类型
默认路由——默认路由在代挂/提号等多业务并存时会静默落到错误的池。REFUND 此前
没有账户字段（后端 `EventCreate.pool_id` 早已支持），这里补上配置与必填约束。

幂等：按 (order_type_code, field_key) 判重。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None

SCOPE = "REFUND"
FIELD_KEY = "pool_id"

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
            label="资金账户",
            field_type="SELECT",
            options=None,
            required=True,
            is_active=True,
            sort_order=35,
            locked=False,
            is_custom=False,
            section="FINANCE",
            note="这笔收支从哪个资金账户进出；显式选择优先于订单类型的默认路由",
            created_by="system",
            updated_by="system",
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.delete(_TABLE)
        .where(_TABLE.c.order_type_code == SCOPE)
        .where(_TABLE.c.field_key == FIELD_KEY)
    )
