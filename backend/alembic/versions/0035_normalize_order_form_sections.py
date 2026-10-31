"""清理建单与库存售出表单中残留的费用字段归属。"""

from alembic import op


revision = "0035_normalize_order_form_sections"
down_revision = "0034_seed_inventory_sale_delivery_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 费用实际产生资金流，不属于业务方案。
    op.execute(
        "UPDATE order_form_fields SET section = 'FINANCE' "
        "WHERE order_type_code IN ('HS', 'TH') "
        "AND field_key IN ('intermediary_fee', 'other_fee_name', 'other_fee_amount', 'other_fee_recipient')"
    )
    op.execute(
        "UPDATE order_form_fields SET section = 'FINANCE' "
        "WHERE order_type_code = 'SALE' AND field_key = 'payment_method'"
    )
    # 这些旧字段已由新的附加支出明细取代，保留定义以兼容历史数据但不再出现在表单。
    op.execute(
        "UPDATE order_form_fields SET is_active = 0 "
        "WHERE order_type_code IN ('HS', 'TH') "
        "AND field_key IN ('other_fee_name', 'other_fee_amount', 'other_fee_recipient', 'design_fee')"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET section = 'BUSINESS' "
        "WHERE order_type_code IN ('HS', 'TH') "
        "AND field_key IN ('intermediary_fee', 'other_fee_name', 'other_fee_amount', 'other_fee_recipient')"
    )
    op.execute(
        "UPDATE order_form_fields SET section = 'BUSINESS' "
        "WHERE order_type_code = 'SALE' AND field_key = 'payment_method'"
    )
    op.execute(
        "UPDATE order_form_fields SET is_active = 1 "
        "WHERE order_type_code IN ('HS', 'TH') "
        "AND field_key IN ('other_fee_name', 'other_fee_amount', 'other_fee_recipient', 'design_fee')"
    )

