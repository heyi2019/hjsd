"""彻底删除已废弃的付款对象字段定义。"""

from alembic import op


revision = "0049_delete_payment_recipient_fields"
down_revision = "0048_add_base_flow_direction"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DELETE FROM order_form_fields WHERE field_key = 'payment_recipient'")


def downgrade() -> None:
    # 历史字段已废弃，不恢复，避免重新出现在建单配置中。
    pass
