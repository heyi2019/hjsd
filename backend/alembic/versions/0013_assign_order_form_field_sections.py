"""按业务语义归位四类建单表的预置字段。"""
from alembic import op


revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


ACCOUNT_KEYS = (
    "game_type", "game_account", "game_password", "channel_region",
    "bound_phone", "has_secondary", "game_account_note",
    "dfq_game_type", "dfq_game_account", "dfq_game_password",
    "dfq_channel_region", "dfq_bound_phone", "dfq_has_secondary", "dfq_account_note",
)
PARTICIPANT_KEYS = (
    "customer_nickname", "customer_source", "customer_contact_name", "customer_phone",
    "customer_wechat", "customer_qq", "dfq_customer_nickname", "dfq_customer_source",
    "dfq_customer_contact", "dfq_customer_phone", "dfq_customer_qq", "dfq_customer_wechat",
    "dg_customer_nickname", "dg_customer_source", "dg_customer_contact", "dg_customer_phone",
    "dg_customer_qq", "dg_customer_wechat", "supplier_nickname", "supplier_source",
    "supplier_source_other", "supplier_contact_name", "supplier_phone", "supplier_wechat",
    "supplier_qq",
)
BUSINESS_KEYS = (
    "intermediary_fee", "intermediary_platform", "intermediary_type", "compensation_type",
    "other_fee_name", "other_fee_amount", "other_fee_recipient", "design_fee", "qa500b_flag",
)
FINANCE_KEYS = (
    "recovery_price", "th_purchase_amount", "th_receive_amount", "dfq_purchase_price",
    "dfq_down_payment", "dfq_service_fee", "dfq_periods", "dfq_period_service_fee",
    "dfq_period_amount", "payment_pool_id", "payment_recipient", "payment_note",
)


def _update(keys: tuple[str, ...], section: str) -> None:
    values = ", ".join(f"'{key}'" for key in keys)
    op.execute(
        f"UPDATE order_form_fields SET section = '{section}' "
        f"WHERE field_key IN ({values})"
    )


def upgrade() -> None:
    _update(ACCOUNT_KEYS, "ACCOUNT_PRODUCT")
    _update(PARTICIPANT_KEYS, "PARTICIPANT")
    _update(BUSINESS_KEYS, "BUSINESS")
    _update(FINANCE_KEYS, "FINANCE")


def downgrade() -> None:
    all_keys = ACCOUNT_KEYS + PARTICIPANT_KEYS + BUSINESS_KEYS + FINANCE_KEYS
    _update(all_keys, "EXTRA")

