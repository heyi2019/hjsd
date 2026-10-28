"""为非建单表单补充明确的字段板块归属。"""
from alembic import op


revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def _update(order_types: tuple[str, ...], keys: tuple[str, ...], section: str) -> None:
    types = ", ".join(f"'{value}'" for value in order_types)
    fields = ", ".join(f"'{value}'" for value in keys)
    op.execute(
        f"UPDATE order_form_fields SET section = '{section}' "
        f"WHERE order_type_code IN ({types}) AND field_key IN ({fields})"
    )


def upgrade() -> None:
    _update(("CUSTOMER",), ("display_name", "contact_name", "phone", "wechat", "qq", "trade_role", "referrer"), "PARTICIPANT")
    _update(("COUNTERPARTY",), ("display_name", "type", "contact_name", "phone", "wechat"), "PARTICIPANT")
    _update(("LEAD",), ("customer_id",), "PARTICIPANT")
    _update(("SALE",), ("customer_id",), "PARTICIPANT")

    # 资金类表单的字段全部属于费用与资金。
    for order_type in ("FUNDDEPOSIT", "FUNDFLOW", "FUNDLOCK", "FUNDLOSS", "FUNDRECON", "FUNDREJECT", "FUNDRELEASE", "FUNDREPAIR", "FUNDREVERSE", "FUNDTRANSFER", "CASHFLOW", "STUDIOEXP"):
        op.execute(f"UPDATE order_form_fields SET section = 'FINANCE' WHERE order_type_code = '{order_type}'")
    _update(("REBATE", "REBREVERSE", "REBSETTLE", "INVREBATE", "INVREFUND"), ("source_order_id", "rebate_type", "base_amount", "rate", "collected_on", "reversed_on", "reason", "gross_amount", "platform_fee", "pool_id", "settled_on", "refund_amount"), "FINANCE")
    _update(("SALE",), ("amount", "pool_id", "down_payment", "service_fee", "periods", "per_period_service_fee", "per_period", "first_due_on"), "FINANCE")
    _update(("INSTPAY", "INSTRECOVER", "INSTRESALE", "INSTSETTLE", "INSTWAIVE"), ("period_no", "amount", "paid_on", "occurred_on", "resale_order_id", "waived_on"), "FINANCE")
    _update(("REFUND", "ORDERCANC"), ("amount", "cancel_amount"), "FINANCE")

    _update(("ORDEREDIT",), ("snap_game_account", "snap_game_type", "snap_game_password", "snap_channel_region", "snap_bound_phone", "snap_note"), "ACCOUNT_PRODUCT")
    _update(("ORDEREDIT", "ORDERLINK", "LEAD", "SALE", "INSTDELIVER", "CONSIGN"), ("snap_platform", "trade_date", "relation_type", "split_ratio", "split_amount", "request_type", "target", "payment_method", "delivery_mode", "platform_ids"), "BUSINESS")
    _update(("LEAD",), ("budget",), "FINANCE")


def downgrade() -> None:
    op.execute("UPDATE order_form_fields SET section = 'EXTRA' WHERE order_type_code NOT IN ('HS', 'TH', 'DG', 'DFQ')")
