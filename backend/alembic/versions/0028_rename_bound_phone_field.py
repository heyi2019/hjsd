"""将建单账号字段「绑定手机号」统一改为「换绑手机号」。"""
from __future__ import annotations

from alembic import op
from sqlalchemy import text


revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        text(
            """
            UPDATE order_form_fields
            SET label = '换绑手机号'
            WHERE (order_type_code IN ('HS', 'TH', 'DG') AND field_key = 'bound_phone')
               OR (order_type_code = 'DFQ' AND field_key = 'dfq_bound_phone')
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        text(
            """
            UPDATE order_form_fields
            SET label = '绑定手机号'
            WHERE (order_type_code IN ('HS', 'TH', 'DG') AND field_key = 'bound_phone')
               OR (order_type_code = 'DFQ' AND field_key = 'dfq_bound_phone')
            """
        )
    )
