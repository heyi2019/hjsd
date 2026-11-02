"""为回收/提号/代挂的「账号/产品」板块登记「钱包实名」字段配置。

字段值落在 stocks.wallet_realname（0005 加列），此处的配置只负责标签、显隐与下拉选项，
与 game_type / has_secondary 等同属 ACCOUNT_PRODUCT 板块。幂等：已存在则跳过。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

FIELD_KEY = "wallet_realname"
SECTION = "ACCOUNT_PRODUCT"
SORT_ORDER = 1055
ORDER_TYPES = ("HS", "TH", "DG")
OPTIONS = [
    {"value": "未注销", "label": "未注销"},
    {"value": "已注销", "label": "已注销"},
]

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


def _exists(bind, order_type_code: str) -> bool:
    count = bind.execute(
        sa.select(sa.func.count())
        .select_from(_TABLE)
        .where(_TABLE.c.order_type_code == order_type_code)
        .where(_TABLE.c.field_key == FIELD_KEY)
    ).scalar()
    return bool(count)


def upgrade() -> None:
    bind = op.get_bind()
    for code in ORDER_TYPES:
        if _exists(bind, code):
            continue
        bind.execute(
            _TABLE.insert().values(
                order_type_code=code,
                field_key=FIELD_KEY,
                label="钱包实名",
                field_type="SELECT",
                options=OPTIONS,
                required=False,
                is_active=True,
                sort_order=SORT_ORDER,
                locked=False,
                is_custom=False,
                section=SECTION,
                note="可选填：账号交付前确认游戏钱包实名是否已解绑",
                created_by="system",
                updated_by="system",
            )
        )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.delete(_TABLE)
        .where(_TABLE.c.field_key == FIELD_KEY)
        .where(_TABLE.c.order_type_code.in_(ORDER_TYPES))
    )
