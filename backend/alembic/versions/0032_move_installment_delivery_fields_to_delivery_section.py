"""将分期交付操作表单的交付字段归入交付信息板块。"""

from alembic import op


revision = "0032_move_installment_delivery_fields_to_delivery_section"
down_revision = "0031_move_order_delivery_fields_to_delivery_section"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET section = 'DELIVER' "
        "WHERE order_type_code = 'INSTDELIVER' "
        "AND field_key IN ('delivery_mode', 'delivered_on', 'note')"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET section = CASE field_key "
        "WHEN 'delivery_mode' THEN 'BUSINESS' ELSE 'EXTRA' END "
        "WHERE order_type_code = 'INSTDELIVER' "
        "AND field_key IN ('delivery_mode', 'delivered_on', 'note')"
    )

