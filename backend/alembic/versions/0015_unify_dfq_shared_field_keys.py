"""统一代分期与回收共用字段键。"""
from alembic import op


revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


RENAMES = {
    "dfq_game_type": "game_type",
    "dfq_game_account": "game_account",
    "dfq_game_password": "game_password",
    "dfq_channel_region": "channel_region",
    "dfq_bound_phone": "bound_phone",
    "dfq_has_secondary": "has_secondary",
    "dfq_account_note": "game_account_note",
    "dfq_customer_nickname": "customer_nickname",
    "dfq_customer_source": "customer_source",
    "dfq_customer_contact": "customer_contact_name",
    "dfq_customer_phone": "customer_phone",
    "dfq_customer_wechat": "customer_wechat",
    "dfq_customer_qq": "customer_qq",
    "dfq_note": "note",
}


def upgrade() -> None:
    for old_key, new_key in RENAMES.items():
        op.execute(
            "UPDATE order_form_fields SET field_key = "
            f"'{new_key}' WHERE order_type_code = 'DFQ' AND field_key = '{old_key}'"
        )


def downgrade() -> None:
    for old_key, new_key in RENAMES.items():
        op.execute(
            "UPDATE order_form_fields SET field_key = "
            f"'{old_key}' WHERE order_type_code = 'DFQ' AND field_key = '{new_key}'"
        )
