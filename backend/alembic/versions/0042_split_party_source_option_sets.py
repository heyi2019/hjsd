"""拆分客户来源与供货方来源主数据，并修正各表单关联。"""

import json

from alembic import op


revision = "0042_split_party_source_option_sets"
down_revision = "0041_seed_party_source_option_set"
branch_labels = None
depends_on = None


SOURCE_OPTIONS = [
    {"value": "自营", "label": "自营"},
    {"value": "微博", "label": "微博"},
    {"value": "小红书", "label": "小红书"},
    {"value": "闲鱼", "label": "闲鱼"},
    {"value": "同行推荐", "label": "同行推荐"},
    {"value": "其他", "label": "其他"},
]


def upgrade() -> None:
    options = json.dumps(SOURCE_OPTIONS, ensure_ascii=False).replace("'", "''")
    # 0041 的临时统一字典不再作为维护入口，避免设置页出现重复来源字典。
    op.execute("DELETE FROM option_sets WHERE code = 'PARTY_SOURCE'")
    for code, label, description in (
        ("CUSTOMER_SOURCE", "客户来源主数据", "回收、代挂、代分期共用的客户来源选项"),
        ("SUPPLIER_SOURCE", "供货方来源主数据", "提号订单使用的供货方来源选项"),
    ):
        op.execute(
            "INSERT INTO option_sets (code, label, \"group\", editable, options, description) "
            f"SELECT '{code}', '{label}', 'BUSINESS', 1, '{options}', '{description}' "
            f"WHERE NOT EXISTS (SELECT 1 FROM option_sets WHERE code = '{code}')"
        )
    op.execute(
        "UPDATE order_form_fields SET options = '" + options + "' "
        "WHERE field_key IN ('customer_source', 'dg_customer_source')"
    )
    op.execute(
        "UPDATE order_form_fields SET options = '" + options + "' "
        "WHERE field_key = 'supplier_source'"
    )


def downgrade() -> None:
    op.execute("DELETE FROM option_sets WHERE code IN ('CUSTOMER_SOURCE', 'SUPPLIER_SOURCE')")
