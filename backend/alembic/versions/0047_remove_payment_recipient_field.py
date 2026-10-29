"""移除已废弃的付款对象表单字段。"""

from alembic import op


revision = "0047_remove_payment_recipient_field"
down_revision = "0046_limit_order_flow_direction_scope"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET is_active = 0 "
        "WHERE field_key = 'payment_recipient'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET is_active = 1 "
        "WHERE field_key = 'payment_recipient'"
    )
