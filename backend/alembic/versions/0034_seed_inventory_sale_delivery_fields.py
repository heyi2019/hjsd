"""补齐库存售出表单的交付字段配置。"""

from alembic import op


revision = "0034_seed_inventory_sale_delivery_fields"
down_revision = "0033_move_inventory_delivery_fields_to_delivery_section"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for field_key, label, sort_order in (
        ("bound_phone", "换绑手机号", 10),
        ("bound_phone_owner", "手机号绑定人", 20),
    ):
        op.execute(
            f"INSERT INTO order_form_fields "
            "(order_type_code, field_key, label, field_type, options, required, required_when, "
            "is_active, sort_order, locked, is_custom, section, note, created_by, updated_by) "
            f"SELECT 'SALE', '{field_key}', '{label}', 'TEXT', NULL, 0, NULL, 1, {sort_order}, "
            "0, 0, 'DELIVER', NULL, 'system', 'system' "
            "WHERE NOT EXISTS (SELECT 1 FROM order_form_fields "
            f"WHERE order_type_code = 'SALE' AND field_key = '{field_key}')"
        )


def downgrade() -> None:
    op.execute(
        "DELETE FROM order_form_fields "
        "WHERE order_type_code = 'SALE' AND field_key IN ('bound_phone', 'bound_phone_owner')"
    )
