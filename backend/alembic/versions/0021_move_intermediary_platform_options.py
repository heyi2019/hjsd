"""把经手平台选项从表单字段迁移到独立主数据词典。"""
from alembic import op


revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE option_sets SET options = '[{\"value\":\"盼之\",\"label\":\"盼之\"},{\"value\":\"千寻\",\"label\":\"千寻\"},{\"value\":\"白情\",\"label\":\"白情\"},{\"value\":\"螃蟹\",\"label\":\"螃蟹\"},{\"value\":\"私下\",\"label\":\"私下\"},{\"value\":\"其他\",\"label\":\"其他\"}]' "
        "WHERE code = 'INTERMEDIARY_PLATFORM'"
    )
    op.execute(
        "UPDATE order_form_fields SET options = NULL "
        "WHERE order_type_code IN ('HS', 'TH') AND field_key = 'intermediary_platform'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET options = '[{\"value\":\"盼之\",\"label\":\"盼之\"},{\"value\":\"千寻\",\"label\":\"千寻\"},{\"value\":\"白情\",\"label\":\"白情\"},{\"value\":\"螃蟹\",\"label\":\"螃蟹\"},{\"value\":\"私下\",\"label\":\"私下\"},{\"value\":\"其他\",\"label\":\"其他\"}]' "
        "WHERE order_type_code IN ('HS', 'TH') AND field_key = 'intermediary_platform'"
    )
    op.execute("UPDATE option_sets SET options = '[]' WHERE code = 'INTERMEDIARY_PLATFORM'")

