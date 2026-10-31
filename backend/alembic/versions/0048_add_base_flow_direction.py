"""补充资金字段的基础信息分类。"""

from alembic import op


revision = "0048_add_base_flow_direction"
down_revision = "0047_remove_payment_recipient_field"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET flow_direction = 'BASE' "
        "WHERE order_type_code IN ('HS','TH','DFQ','SALE') AND section = 'FINANCE' "
        "AND field_key IN ('payment_pool_id','payment_note','payment_method','periods',"
        "'dfq_periods','first_due_on')"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET flow_direction = NULL "
        "WHERE flow_direction = 'BASE'"
    )

