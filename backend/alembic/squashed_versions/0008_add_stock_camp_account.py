"""为库存账号补充「营地账号」列与建单字段配置。

业务背景：营地账号是游戏账号对应的官方社区账号（如网易营地），
随号交付、不参与任何金额核算，因此以固定列承载（可空），不入活字段。

存量数据为空，不做回填；建单表单的标签/显隐由 order_form_fields 配置驱动，
与 game_account / wallet_realname 同属 ACCOUNT_PRODUCT 板块。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

COLUMN = "camp_account"
SECTION = "ACCOUNT_PRODUCT"
SORT_ORDER = 1025
ORDER_TYPES = ("HS", "TH", "DG")

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


def _field_exists(bind, order_type_code: str) -> bool:
    count = bind.execute(
        sa.select(sa.func.count())
        .select_from(_TABLE)
        .where(_TABLE.c.order_type_code == order_type_code)
        .where(_TABLE.c.field_key == COLUMN)
    ).scalar()
    return bool(count)


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("stocks")}
    if COLUMN not in columns:
        op.add_column("stocks", sa.Column(COLUMN, sa.String(128), nullable=True))
    for code in ORDER_TYPES:
        if _field_exists(bind, code):
            continue
        bind.execute(
            _TABLE.insert().values(
                order_type_code=code,
                field_key=COLUMN,
                label="营地账号",
                field_type="TEXT",
                options=None,
                required=False,
                is_active=True,
                sort_order=SORT_ORDER,
                locked=False,
                is_custom=False,
                section=SECTION,
                note="可选填：账号绑定的官方社区（营地）账号",
                created_by="system",
                updated_by="system",
            )
        )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.delete(_TABLE)
        .where(_TABLE.c.field_key == COLUMN)
        .where(_TABLE.c.order_type_code.in_(ORDER_TYPES))
    )
    columns = {column["name"] for column in sa.inspect(bind).get_columns("stocks")}
    if COLUMN in columns:
        with op.batch_alter_table("stocks") as batch_op:
            batch_op.drop_column(COLUMN)
