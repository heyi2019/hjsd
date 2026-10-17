"""split cashflow ownership, direction and accounting classification."""
from __future__ import annotations

from typing import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "cashflow",
        sa.Column(
            "fund_nature",
            sa.String(length=16),
            nullable=False,
            server_default=sa.text("'BUSINESS'"),
        ),
    )
    op.add_column(
        "cashflow",
        sa.Column(
            "accounting_attribute",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'OPERATING_EXPENSE'"),
        ),
    )
    op.execute(
        sa.text(
            "UPDATE cashflow SET fund_nature = CASE "
            "WHEN nature = 'INTERNAL' THEN 'INTERNAL' "
            "WHEN nature = 'EXTERNAL_IN' THEN 'EXTERNAL' "
            "ELSE 'BUSINESS' END"
        )
    )
    op.execute(
        sa.text(
            "UPDATE cashflow SET accounting_attribute = CASE "
            "WHEN nature = 'INTERNAL' OR category = 'TRANSFER' THEN 'INTERNAL_TRANSFER' "
            "WHEN category IN ('REBATE', 'REBATE_REVERSAL') THEN "
            "CASE WHEN category = 'REBATE_REVERSAL' THEN 'REVERSAL' ELSE 'REBATE_INCOME' END "
            "WHEN category IN ('DEPOSIT_HOLD', 'DEPOSIT_RELEASE', 'DEPOSIT_LOSS') THEN 'DEPOSIT' "
            "WHEN category = 'REVERSAL' THEN 'REVERSAL' "
            "WHEN category = 'BUY' AND order_id IN (SELECT id FROM orders WHERE order_type = 'HS') THEN 'SELF_DIRECT_COST' "
            "WHEN category = 'BUY' AND order_id IN (SELECT id FROM orders WHERE order_type = 'TH') THEN 'TH_DIRECT_COST' "
            "WHEN category = 'BUY' AND order_id IN (SELECT id FROM orders WHERE order_type = 'DFQ') THEN 'DFQ_PRINCIPAL' "
            "WHEN category = 'SELL' AND order_id IN (SELECT id FROM orders WHERE order_type = 'HS') THEN 'SELF_REVENUE' "
            "WHEN category = 'SELL' AND order_id IN (SELECT id FROM orders WHERE order_type = 'TH') THEN 'TH_REVENUE' "
            "WHEN category = 'SELL' AND order_id IN (SELECT id FROM orders WHERE order_type = 'DG') THEN 'SERVICE_REVENUE' "
            "WHEN category = 'PAYMENT' AND order_id IN (SELECT id FROM orders WHERE order_type = 'DFQ') THEN 'DFQ_PRINCIPAL' "
            "WHEN category IN ('SELL', 'PAYMENT') THEN 'SELF_REVENUE' "
            "ELSE 'OPERATING_EXPENSE' END"
        )
    )
    with op.batch_alter_table("cashflow", schema=None) as batch_op:
        batch_op.create_check_constraint(
            "cashflow_fund_nature_valid",
            "fund_nature IN ('BUSINESS', 'EXTERNAL', 'INTERNAL')",
        )
        batch_op.create_check_constraint(
            "cashflow_accounting_attribute_valid",
            "accounting_attribute IN ('SELF_REVENUE', 'SELF_DIRECT_COST', 'TH_DIRECT_COST', 'TH_REVENUE', 'DFQ_PRINCIPAL', 'SERVICE_REVENUE', 'REBATE_INCOME', 'OPERATING_EXPENSE', 'DEPOSIT', 'EXTERNAL_FUNDING', 'INTERNAL_TRANSFER', 'REVERSAL')",
        )
        batch_op.create_index("ix_cashflow_fund_nature", ["fund_nature"])
        batch_op.create_index("ix_cashflow_accounting_attribute", ["accounting_attribute"])


def downgrade() -> None:
    with op.batch_alter_table("cashflow", schema=None) as batch_op:
        batch_op.drop_index("ix_cashflow_accounting_attribute")
        batch_op.drop_index("ix_cashflow_fund_nature")
        batch_op.drop_constraint("cashflow_accounting_attribute_valid", type_="check")
        batch_op.drop_constraint("cashflow_fund_nature_valid", type_="check")
        batch_op.drop_column("accounting_attribute")
        batch_op.drop_column("fund_nature")
