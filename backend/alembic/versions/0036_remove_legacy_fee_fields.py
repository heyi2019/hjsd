"""删除已由附加支出明细替代的旧费用字段定义。"""

from alembic import op


revision = "0036_remove_legacy_fee_fields"
down_revision = "0035_normalize_order_form_sections"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "DELETE FROM order_form_fields "
        "WHERE order_type_code IN ('HS', 'TH') "
        "AND field_key IN ('design_fee', 'other_fee_name', 'other_fee_amount', 'other_fee_recipient')"
    )


def downgrade() -> None:
    # 旧字段已被新的附加支出明细模型取代，不在回滚时重新引入过时定义。
    pass

