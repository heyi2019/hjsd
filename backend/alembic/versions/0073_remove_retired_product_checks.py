"""收紧已下线产品的数据库 CHECK 约束。

0072 清理了代分期的运行时配置，但历史基线中的 CHECK 仍接受旧枚举值。
本迁移让数据库约束与当前 domain enums 保持一致，避免绕过 API 直接写入遗留产品。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.sql.naming import conv


revision = "0073_remove_retired_product_checks"
down_revision = "0072_remove_dfq_order_type"
branch_labels = None
depends_on = None


def _find_check(table_name: str, *tokens: str) -> str | None:
    inspector = sa.inspect(op.get_bind())
    wanted = tuple(token.upper() for token in tokens)
    for constraint in inspector.get_check_constraints(table_name):
        name = constraint.get("name")
        sqltext = (constraint.get("sqltext") or "").upper()
        if name and all(token in sqltext for token in wanted):
            return name
    return None


def _replace_check(
    table_name: str,
    old_tokens: tuple[str, ...],
    name: str,
    expression: str,
) -> None:
    with op.batch_alter_table(table_name, naming_convention={}) as batch_op:
        old_name = _find_check(table_name, *old_tokens)
        if old_name:
            batch_op.drop_constraint(conv(old_name), type_="check")
        batch_op.create_check_constraint(conv(name), expression)


def upgrade() -> None:
    _replace_check(
        "orders",
        ("CAPITAL_TYPE", "CREDIT"),
        "ck_orders_order_capital_type_valid",
        "capital_type IN ('STOCK', 'ZERO')",
    )
    _replace_check(
        "order_type_defs",
        ("CAPITAL_TYPE", "CREDIT"),
        "ck_order_type_defs_capital_type_valid",
        "capital_type IN ('STOCK', 'ZERO')",
    )
    _replace_check(
        "orders",
        ("ACCOUNT_SNAPSHOT", "DFQ"),
        "ck_orders_order_account_snapshot_type_valid",
        "account_snapshot IS NULL OR account_snapshot = 'null' "
        "OR order_type IN ('HS', 'TH', 'DG')",
    )
    _replace_check(
        "installments",
        ("CONTRACT_TYPE", "ADVANCE_PURCHASE"),
        "ck_installments_installment_contract_valid",
        "contract_type IN ('STOCK_SALE', 'PICKUP_SALE', 'CONSIGNMENT_SALE')",
    )
    _replace_check(
        "cashflow",
        ("ACCOUNTING_ATTRIBUTE", "DFQ_PRINCIPAL"),
        "ck_cashflow_cashflow_accounting_attribute_valid",
        "accounting_attribute IN ('SELF_REVENUE', 'SELF_DIRECT_COST', 'TH_DIRECT_COST', "
        "'TH_REVENUE', 'SERVICE_REVENUE', 'REBATE_INCOME', 'OPERATING_EXPENSE', "
        "'DEPOSIT', 'EXTERNAL_FUNDING', 'INTERNAL_TRANSFER', 'REVERSAL', 'REFUND')",
    )


def downgrade() -> None:
    _replace_check(
        "orders",
        ("CAPITAL_TYPE", "'STOCK'", "'ZERO'"),
        "ck_orders_order_capital_type_valid",
        "capital_type IN ('STOCK', 'ZERO', 'CREDIT')",
    )
    _replace_check(
        "order_type_defs",
        ("CAPITAL_TYPE", "'STOCK'", "'ZERO'"),
        "ck_order_type_defs_capital_type_valid",
        "capital_type IN ('STOCK', 'ZERO', 'CREDIT')",
    )
    _replace_check(
        "orders",
        ("ACCOUNT_SNAPSHOT", "'HS'", "'DG'"),
        "ck_orders_order_account_snapshot_type_valid",
        "account_snapshot IS NULL OR account_snapshot = 'null' "
        "OR order_type IN ('HS', 'TH', 'DG', 'DFQ')",
    )
    _replace_check(
        "installments",
        ("CONTRACT_TYPE", "'STOCK_SALE'", "'PICKUP_SALE'"),
        "ck_installments_installment_contract_valid",
        "contract_type IN ('STOCK_SALE', 'ADVANCE_PURCHASE', 'PICKUP_SALE', 'CONSIGNMENT_SALE')",
    )
    _replace_check(
        "cashflow",
        ("ACCOUNTING_ATTRIBUTE", "'SELF_REVENUE'", "'REFUND'"),
        "ck_cashflow_cashflow_accounting_attribute_valid",
        "accounting_attribute IN ('SELF_REVENUE', 'SELF_DIRECT_COST', 'TH_DIRECT_COST', "
        "'TH_REVENUE', 'DFQ_PRINCIPAL', 'SERVICE_REVENUE', 'REBATE_INCOME', "
        "'OPERATING_EXPENSE', 'DEPOSIT', 'EXTERNAL_FUNDING', 'INTERNAL_TRANSFER', "
        "'REVERSAL', 'REFUND')",
    )
