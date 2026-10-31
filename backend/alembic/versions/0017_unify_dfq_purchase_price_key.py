"""统一代分期与回收的账号号价字段键。"""
from alembic import op


revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET field_key = 'recovery_price' "
        "WHERE order_type_code = 'DFQ' AND field_key = 'dfq_purchase_price'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET field_key = 'dfq_purchase_price' "
        "WHERE order_type_code = 'DFQ' AND field_key = 'recovery_price'"
    )

