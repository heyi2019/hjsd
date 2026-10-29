"""仅将客户备注和供货方备注归入客户/供货方信息。"""

from alembic import op


revision = "0040_keep_only_customer_supplier_notes"
down_revision = "0039_move_party_notes_to_participant_section"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 代挂备注、分期备注不是客户/供货方备注，恢复到其他补充信息。
    op.execute(
        "UPDATE order_form_fields SET section = 'EXTRA', sort_order = 5010 "
        "WHERE order_type_code = 'DG' AND field_key = 'dg_note'"
    )
    op.execute(
        "UPDATE order_form_fields SET section = 'EXTRA', sort_order = 5010 "
        "WHERE order_type_code = 'DFQ' AND field_key = 'note'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE order_form_fields SET section = 'PARTICIPANT', sort_order = 4900 "
        "WHERE order_type_code = 'DG' AND field_key = 'dg_note'"
    )
    op.execute(
        "UPDATE order_form_fields SET section = 'PARTICIPANT', sort_order = 4900 "
        "WHERE order_type_code = 'DFQ' AND field_key = 'note'"
    )
