"""Put customer-source details in participant sections and complete DFQ config."""

from alembic import op


revision = "0030_add_customer_source_other_field"
down_revision = "0029_rename_intermediary_platform_to_trade_platform"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 既有回收、代挂字段此前会落在「其他补充信息」，统一归入客户所属的参与方板块。
    op.execute(
        "UPDATE order_form_fields SET section = 'PARTICIPANT' "
        "WHERE (order_type_code = 'HS' AND field_key = 'customer_source_other') "
        "OR (order_type_code = 'DG' AND field_key = 'dg_customer_source_other')"
    )
    # 代分期复用 customer_source 后，同步补齐「其他来源」配置，供设置 → 表单字段维护。
    op.execute(
        "INSERT INTO order_form_fields "
        "(order_type_code, field_key, label, field_type, options, required, required_when, "
        "is_active, sort_order, locked, is_custom, section, note) "
        "SELECT 'DFQ', 'customer_source_other', '其他来源', 'TEXT', NULL, 0, "
        "'{\"field\": \"customer_source\", \"op\": \"eq\", \"values\": [\"其他\"]}', "
        "1, 225, 0, 0, 'PARTICIPANT', NULL "
        "WHERE NOT EXISTS ("
        "SELECT 1 FROM order_form_fields "
        "WHERE order_type_code = 'DFQ' AND field_key = 'customer_source_other'"
        ")"
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM order_form_fields "
        "WHERE order_type_code = 'DFQ' AND field_key = 'customer_source_other'"
    )
    op.execute(
        "UPDATE order_form_fields SET section = 'EXTRA' "
        "WHERE (order_type_code = 'HS' AND field_key = 'customer_source_other') "
        "OR (order_type_code = 'DG' AND field_key = 'dg_customer_source_other')"
    )

