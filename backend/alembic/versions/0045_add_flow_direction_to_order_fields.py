"""将表单资金字段属性改为资金流向：收入或支出。"""

import sqlalchemy as sa
from alembic import op


revision = "0045_add_flow_direction_to_order_fields"
down_revision = "0044_add_order_field_fund_nature"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("order_form_fields", sa.Column("flow_direction", sa.String(length=8), nullable=True))
    op.drop_column("order_form_fields", "fund_nature")
    op.execute(
        "UPDATE order_form_fields SET flow_direction = 'OUT' "
        "WHERE section = 'FINANCE' AND field_key IN ("
        "'recovery_price','th_purchase_amount','intermediary_fee','payment_pool_id',"
        "'payment_recipient','payment_note'"
        ")"
    )
    op.execute(
        "UPDATE order_form_fields SET flow_direction = 'IN' "
        "WHERE section = 'FINANCE' AND field_key IN ("
        "'th_receive_amount','amount','payment_method','pool_id','down_payment',"
        "'service_fee','periods','per_period_service_fee','per_period'"
        ")"
    )
    op.execute(
        "UPDATE order_form_fields SET flow_direction = 'OUT' "
        "WHERE section = 'FINANCE' AND field_key IN ("
        "'dfq_down_payment','dfq_service_fee','dfq_period_service_fee','dfq_period_amount'"
        ")"
    )


def downgrade() -> None:
    op.add_column("order_form_fields", sa.Column("fund_nature", sa.String(length=16), nullable=True))
    op.drop_column("order_form_fields", "flow_direction")
