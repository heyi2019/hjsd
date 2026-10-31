"""统一代分期与回收的付款字段键。"""
from alembic import op


revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


RENAMES = {
    "dfq_payment_pool_id": "payment_pool_id",
    "dfq_payment_recipient": "payment_recipient",
    "dfq_payment_note": "payment_note",
}


def upgrade() -> None:
    for old_key, new_key in RENAMES.items():
        op.execute(
            "UPDATE order_form_fields SET field_key = "
            f"'{new_key}' WHERE order_type_code = 'DFQ' AND field_key = '{old_key}'"
        )


def downgrade() -> None:
    for old_key, new_key in RENAMES.items():
        op.execute(
            "UPDATE order_form_fields SET field_key = "
            f"'{old_key}' WHERE order_type_code = 'DFQ' AND field_key = '{new_key}'"
        )

