"""为建单三个作用域的各板块预留「补充1/2/3」占位字段。

业务背景：用户希望在回收/提号/代挂建单表单的每个板块末尾都留三个自由填写位，
不必每次找管理员新建自定义字段。因此以 `is_custom=True` 的普通自定义字段预置：
- 值走既有 form_extra / account extra_values 通道，不新增表结构；
- 管理员可在「设置 → 订单表单字段」改名、调序、停用或删除；
- 只覆盖该作用域实际渲染的板块（HS/TH 无 BUSINESS 渲染点，DG 无 FINANCE 渲染点），
  避免留下永远不显示的僵尸字段。

幂等：按 (order_type_code, field_key) 判重。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None

# 作用域 → 该表单实际挂载 CustomFieldSection 的板块
SCOPE_SECTIONS = {
    "HS": ("ACCOUNT_PRODUCT", "FINANCE", "PARTICIPANT", "EXTRA"),
    "TH": ("ACCOUNT_PRODUCT", "FINANCE", "PARTICIPANT", "EXTRA"),
    "DG": ("ACCOUNT_PRODUCT", "BUSINESS", "DELIVER", "PARTICIPANT", "EXTRA"),
}

# 板块排序基数：建单表单里板块顺序由组件位置决定，基数只影响板块内排序，
# 取「基数 + 900/910/920」把补充字段压在本板块末尾。
SECTION_BASE = {
    "ACCOUNT_PRODUCT": 1000,
    "DELIVER": 2000,
    "FINANCE": 3000,
    "PARTICIPANT": 4000,
    "EXTRA": 5000,
    "BUSINESS": 6000,
}
SECTION_KEY_PREFIX = {
    "ACCOUNT_PRODUCT": "account_product",
    "DELIVER": "deliver",
    "FINANCE": "finance",
    "PARTICIPANT": "participant",
    "EXTRA": "extra",
    "BUSINESS": "business",
}
OFFSETS = (900, 910, 920)

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


def _exists(bind, order_type_code: str, field_key: str) -> bool:
    count = bind.execute(
        sa.select(sa.func.count())
        .select_from(_TABLE)
        .where(_TABLE.c.order_type_code == order_type_code)
        .where(_TABLE.c.field_key == field_key)
    ).scalar()
    return bool(count)


def upgrade() -> None:
    bind = op.get_bind()
    for code, sections in SCOPE_SECTIONS.items():
        for section in sections:
            for index, offset in enumerate(OFFSETS, start=1):
                field_key = f"supplement_{SECTION_KEY_PREFIX[section]}_{index}"
                if _exists(bind, code, field_key):
                    continue
                bind.execute(
                    _TABLE.insert().values(
                        order_type_code=code,
                        field_key=field_key,
                        label=f"补充{index}",
                        field_type="TEXT",
                        options=None,
                        required=False,
                        is_active=True,
                        sort_order=SECTION_BASE[section] + offset,
                        locked=False,
                        is_custom=True,
                        section=section,
                        note="预置的自由填写位，可在设置中改名或停用",
                        created_by="system",
                        updated_by="system",
                    )
                )


def downgrade() -> None:
    bind = op.get_bind()
    for code, sections in SCOPE_SECTIONS.items():
        keys = [
            f"supplement_{SECTION_KEY_PREFIX[section]}_{index}"
            for section in sections
            for index in range(1, len(OFFSETS) + 1)
        ]
        bind.execute(
            sa.delete(_TABLE)
            .where(_TABLE.c.order_type_code == code)
            .where(_TABLE.c.field_key.in_(keys))
        )
