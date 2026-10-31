"""将代分期付款字段归入费用与资金。"""
from alembic import op


revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET section = 'FINANCE' "
        "WHERE order_type_code = 'DFQ' AND field_key IN "
        "('dfq_payment_pool_id', 'dfq_payment_recipient', 'dfq_payment_note')"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET section = 'EXTRA' "
        "WHERE order_type_code = 'DFQ' AND field_key IN "
        "('dfq_payment_pool_id', 'dfq_payment_recipient', 'dfq_payment_note')"
    )

