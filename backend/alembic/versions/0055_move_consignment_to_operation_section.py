"""将寄售平台登记字段归入运营信息板块。"""
from __future__ import annotations

from alembic import op


revision = "0055_move_consignment_to_operation_section"
down_revision = "0054_seed_allocation_form_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET section = 'OPERATION' "
        "WHERE order_type_code = 'CONSIGN' AND field_key = 'platform_ids'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET section = 'DELIVER' "
        "WHERE order_type_code = 'CONSIGN' AND field_key = 'platform_ids'"
    )
