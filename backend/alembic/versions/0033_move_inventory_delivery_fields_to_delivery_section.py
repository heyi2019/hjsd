"""将库存售出与寄售表单中的交付字段归入交付信息板块。"""

from alembic import op


revision = "0033_move_inventory_delivery_fields_to_delivery_section"
down_revision = "0032_move_installment_delivery_fields_to_delivery_section"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET section = 'DELIVER' "
        "WHERE order_type_code = 'SALE' "
        "AND field_key IN ('bound_phone', 'bound_phone_owner')"
    )
    op.execute(
        "UPDATE order_form_fields SET section = 'DELIVER' "
        "WHERE order_type_code = 'CONSIGN' AND field_key = 'platform_ids'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET section = 'ACCOUNT_PRODUCT' "
        "WHERE order_type_code = 'SALE' "
        "AND field_key IN ('bound_phone', 'bound_phone_owner')"
    )
    op.execute(
        "UPDATE order_form_fields SET section = 'BUSINESS' "
        "WHERE order_type_code = 'CONSIGN' AND field_key = 'platform_ids'"
    )

