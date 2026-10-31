"""将建单交付字段从业务方案/账号信息归入独立的交付信息板块。"""

from alembic import op


revision = "0031_move_order_delivery_fields_to_delivery_section"
down_revision = "0030_add_customer_source_other_field"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET section = 'DELIVER' "
        "WHERE order_type_code IN ('HS', 'TH', 'DG', 'DFQ') "
        "AND field_key IN ("
        "'bound_phone', 'bound_phone_owner', 'intermediary_platform', "
        "'intermediary_type', 'compensation_type'"
        ")"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET section = 'ACCOUNT_PRODUCT' "
        "WHERE order_type_code IN ('HS', 'TH', 'DG', 'DFQ') "
        "AND field_key IN ('bound_phone', 'bound_phone_owner')"
    )
    op.execute(
        "UPDATE order_form_fields SET section = 'BUSINESS' "
        "WHERE order_type_code IN ('HS', 'TH', 'DG', 'DFQ') "
        "AND field_key IN ('intermediary_platform', 'intermediary_type', 'compensation_type')"
    )

