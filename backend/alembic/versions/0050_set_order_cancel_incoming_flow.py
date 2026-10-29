"""将取消交易冲销金额标记为退款入账。"""

from alembic import op


revision = "0050_set_order_cancel_incoming_flow"
down_revision = "0049_delete_payment_recipient_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET flow_direction = 'IN' "
        "WHERE order_type_code = 'ORDERCANC' AND field_key = 'cancel_amount'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET flow_direction = NULL "
        "WHERE order_type_code = 'ORDERCANC' AND field_key = 'cancel_amount'"
    )
