"""仅为订单建单资金字段设置资金流向属性。"""

from alembic import op


revision = "0046_limit_order_flow_direction_scope"
down_revision = "0045_add_flow_direction_to_order_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET flow_direction = NULL "
        "WHERE order_type_code NOT IN ('HS', 'TH', 'DFQ', 'SALE')"
    )


def downgrade() -> None:
    pass
