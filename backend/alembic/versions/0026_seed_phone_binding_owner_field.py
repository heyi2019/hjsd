"""为回收与代分期建单补充手机号绑定人核心字段。"""
from alembic import op


revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None


_ROWS = (
    ("HS", 185),
    ("DFQ", 75),
)


def upgrade() -> None:
    for order_type_code, sort_order in _ROWS:
        op.execute(
            f"""
            INSERT INTO order_form_fields
                (order_type_code, field_key, label, field_type, required, is_active,
                 sort_order, locked, is_custom, created_by, updated_by)
            SELECT '{order_type_code}', 'bound_phone_owner', '手机号绑定人', 'TEXT', 0, 1,
                   {sort_order}, 1, 0, 'system', 'system'
            WHERE NOT EXISTS (
                SELECT 1 FROM order_form_fields
                WHERE order_type_code = '{order_type_code}' AND field_key = 'bound_phone_owner'
            )
            """
        )


def downgrade() -> None:
    op.execute(
        "DELETE FROM order_form_fields "
        "WHERE order_type_code IN ('HS', 'DFQ') AND field_key = 'bound_phone_owner'"
    )

