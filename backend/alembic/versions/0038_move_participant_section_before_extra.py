"""将客户/供货方板块排在其他补充信息之前。"""

from alembic import op


revision = "0038_move_participant_section_before_extra"
down_revision = "0037_reorder_order_form_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 统一将参与方排为第 5 组、其他补充排为第 6 组。
    op.execute(
        "UPDATE order_form_fields SET sort_order = 4000 + (sort_order % 1000) "
        "WHERE order_type_code IN ('HS', 'TH', 'DG', 'DFQ', 'SALE') "
        "AND section = 'PARTICIPANT'"
    )
    op.execute(
        "UPDATE order_form_fields SET sort_order = 5000 + (sort_order % 1000) "
        "WHERE order_type_code IN ('HS', 'TH', 'DG', 'DFQ', 'SALE') "
        "AND section = 'EXTRA'"
    )


def downgrade() -> None:
    pass
