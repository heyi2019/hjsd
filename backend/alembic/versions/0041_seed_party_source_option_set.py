"""统一客户与供货方来源选项。"""

import json

from alembic import op


revision = "0041_seed_party_source_option_set"
down_revision = "0040_keep_only_customer_supplier_notes"
branch_labels = None
depends_on = None


PARTY_SOURCE_OPTIONS = [
    {"value": "自营", "label": "自营"},
    {"value": "微博", "label": "微博"},
    {"value": "小红书", "label": "小红书"},
    {"value": "闲鱼", "label": "闲鱼"},
    {"value": "同行推荐", "label": "同行推荐"},
    {"value": "其他", "label": "其他"},
]


def upgrade() -> None:
    options = json.dumps(PARTY_SOURCE_OPTIONS, ensure_ascii=False)
    escaped = options.replace("'", "''")
    op.execute(
        "INSERT INTO option_sets (code, label, \"group\", editable, options, description) "
        "SELECT 'PARTY_SOURCE', '参与方来源', 'BUSINESS', 1, '" + escaped + "', "
        "'客户与供货方共用的来源选项' "
        "WHERE NOT EXISTS (SELECT 1 FROM option_sets WHERE code = 'PARTY_SOURCE')"
    )
    op.execute(
        "UPDATE order_form_fields SET options = '" + escaped + "' "
        "WHERE field_key IN ('customer_source', 'supplier_source', 'dg_customer_source')"
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM option_sets WHERE code = 'PARTY_SOURCE'"
    )
