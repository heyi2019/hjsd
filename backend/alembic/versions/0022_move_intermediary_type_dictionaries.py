"""将中介类型和包赔类型迁移到独立业务字典。"""
from alembic import op


revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "INSERT INTO option_sets (code, label, \"group\", editable, options, description) "
        "SELECT 'INTERMEDIARY_TYPE', '中介类型', 'BUSINESS', 1, "
        "'[{\"value\":\"普中\",\"label\":\"普中\"},{\"value\":\"包赔\",\"label\":\"包赔\"}]', '中介费用类型' "
        "WHERE NOT EXISTS (SELECT 1 FROM option_sets WHERE code = 'INTERMEDIARY_TYPE')"
    )
    op.execute(
        "INSERT INTO option_sets (code, label, \"group\", editable, options, description) "
        "SELECT 'COMPENSATION_TYPE', '包赔类型', 'BUSINESS', 1, "
        "'[{\"value\":\"shoubao\",\"label\":\"首保\"},{\"value\":\"xubao\",\"label\":\"续保\"},{\"value\":\"zhuanxu\",\"label\":\"转续\"}]', '包赔保障类型' "
        "WHERE NOT EXISTS (SELECT 1 FROM option_sets WHERE code = 'COMPENSATION_TYPE')"
    )
    op.execute("UPDATE order_form_fields SET options = NULL WHERE order_type_code IN ('HS', 'TH') AND field_key IN ('intermediary_type', 'compensation_type')")


def downgrade() -> None:
    op.execute("DELETE FROM option_sets WHERE code IN ('INTERMEDIARY_TYPE', 'COMPENSATION_TYPE')")

