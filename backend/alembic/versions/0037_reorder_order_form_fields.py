"""按板块顺序重排各业务表单字段。"""

from alembic import op


revision = "0037_reorder_order_form_fields"
down_revision = "0036_remove_legacy_fee_fields"
branch_labels = None
depends_on = None


FIELD_ORDER = {
    "HS": (
        ("ACCOUNT_PRODUCT", ("game_type", "game_account", "game_password", "channel_region", "has_secondary", "game_account_note")),
        ("DELIVER", ("bound_phone", "bound_phone_owner", "intermediary_platform", "intermediary_type", "compensation_type")),
        ("FINANCE", ("recovery_price", "intermediary_fee", "payment_pool_id", "payment_recipient", "payment_note")),
        ("EXTRA", ("note",)),
        ("PARTICIPANT", ("customer_nickname", "customer_source", "customer_contact_name", "customer_phone", "customer_wechat", "customer_qq")),
    ),
    "TH": (
        ("ACCOUNT_PRODUCT", ("game_type", "game_account", "game_password", "channel_region", "has_secondary", "game_account_note")),
        ("DELIVER", ("bound_phone", "bound_phone_owner", "intermediary_platform", "intermediary_type", "compensation_type")),
        ("FINANCE", ("th_purchase_amount", "th_receive_amount", "intermediary_fee", "payment_pool_id", "payment_recipient", "payment_note")),
        ("EXTRA", ("supplier_note",)),
        ("PARTICIPANT", ("supplier_nickname", "supplier_source", "supplier_source_other", "supplier_contact_name", "supplier_phone", "supplier_wechat", "supplier_qq")),
    ),
    "DG": (
        ("ACCOUNT_PRODUCT", ("game_type", "game_account", "game_password", "channel_region", "has_secondary", "game_account_note")),
        ("DELIVER", ("bound_phone", "bound_phone_owner")),
        ("EXTRA", ("dg_note",)),
        ("PARTICIPANT", ("dg_customer_nickname", "dg_customer_source", "dg_customer_source_other", "dg_customer_contact", "dg_customer_phone", "dg_customer_wechat", "dg_customer_qq")),
    ),
    "DFQ": (
        ("ACCOUNT_PRODUCT", ("game_type", "game_account", "game_password", "channel_region", "has_secondary", "game_account_note")),
        ("DELIVER", ("bound_phone", "bound_phone_owner")),
        ("FINANCE", ("recovery_price", "dfq_down_payment", "dfq_service_fee", "dfq_periods", "dfq_period_service_fee", "dfq_period_amount", "payment_pool_id", "payment_recipient", "payment_note")),
        ("EXTRA", ("note",)),
        ("PARTICIPANT", ("customer_nickname", "customer_source", "customer_source_other", "customer_contact_name", "customer_phone", "customer_wechat", "customer_qq")),
    ),
    "SALE": (
        ("DELIVER", ("bound_phone", "bound_phone_owner")),
        ("FINANCE", ("amount", "payment_method", "pool_id", "down_payment", "service_fee", "periods", "per_period_service_fee", "per_period", "first_due_on")),
        ("EXTRA", ("note",)),
        ("PARTICIPANT", ("customer_id",)),
    ),
    "CONSIGN": (("DELIVER", ("platform_ids",)),),
    "INSTDELIVER": (("DELIVER", ("delivery_mode", "delivered_on", "note")),),
}


def upgrade() -> None:
    for order_type, groups in FIELD_ORDER.items():
        for section_index, (section, fields) in enumerate(groups, start=1):
            for field_index, field_key in enumerate(fields, start=1):
                sort_order = section_index * 1000 + field_index * 10
                op.execute(
                    "UPDATE order_form_fields SET section = "
                    f"'{section}', sort_order = {sort_order} "
                    f"WHERE order_type_code = '{order_type}' AND field_key = '{field_key}'"
                )


def downgrade() -> None:
    # 排序调整不改变字段内容，回滚时保留当前稳定顺序。
    pass

