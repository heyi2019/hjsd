"""为资金字段增加资金性质配置。"""

import sqlalchemy as sa
from alembic import op


revision = "0044_add_order_field_fund_nature"
down_revision = "0043_rename_payment_pool_label"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("order_form_fields", sa.Column("fund_nature", sa.String(length=16), nullable=True))
    op.execute(
        "UPDATE order_form_fields SET fund_nature = 'BUSINESS' "
        "WHERE section = 'FINANCE' AND field_key IN ("
        "'recovery_price','th_purchase_amount','th_receive_amount','intermediary_fee',"
        "'amount','down_payment','service_fee','per_period_service_fee','per_period',"
        "'dfq_down_payment','dfq_service_fee','dfq_period_service_fee','dfq_period_amount'"
        ")"
    )


def downgrade() -> None:
    op.drop_column("order_form_fields", "fund_nature")

