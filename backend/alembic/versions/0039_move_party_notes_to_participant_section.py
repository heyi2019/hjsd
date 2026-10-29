"""将客户/供货方备注归入客户/供货方信息板块。"""

from alembic import op


revision = "0039_move_party_notes_to_participant_section"
down_revision = "0038_move_participant_section_before_extra"
branch_labels = None
depends_on = None


PARTY_NOTES = {
    "HS": "note",
    "TH": "supplier_note",
    "DG": "dg_note",
    "DFQ": "note",
}


def upgrade() -> None:
    for order_type, field_key in PARTY_NOTES.items():
        op.execute(
            "UPDATE order_form_fields SET section = 'PARTICIPANT', sort_order = 4900 "
            f"WHERE order_type_code = '{order_type}' AND field_key = '{field_key}'"
        )


def downgrade() -> None:
    for order_type, field_key in PARTY_NOTES.items():
        op.execute(
            "UPDATE order_form_fields SET section = 'EXTRA', sort_order = 5010 "
            f"WHERE order_type_code = '{order_type}' AND field_key = '{field_key}'"
        )
