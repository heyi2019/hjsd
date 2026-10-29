"""将付款资金账户统一称为资金账户。"""

from alembic import op


revision = "0043_rename_payment_pool_label"
down_revision = "0042_split_party_source_option_sets"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET label = '资金账户' "
        "WHERE field_key = 'payment_pool_id' AND label = '付款资金账户'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET label = '付款资金账户' "
        "WHERE field_key = 'payment_pool_id' AND label = '资金账户'"
    )
