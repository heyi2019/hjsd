"""为分润支出启用独立资金明细核算属性。"""
from __future__ import annotations

from alembic import op


revision = "0004_profit_share_cashflow"
down_revision = "0003_align_legacy_schema"
branch_labels = None
depends_on = None


_ATTRIBUTES = (
    "SELF_REVENUE",
    "SELF_DIRECT_COST",
    "TH_DIRECT_COST",
    "TH_REVENUE",
    "SERVICE_REVENUE",
    "REBATE_INCOME",
    "OPERATING_EXPENSE",
    "PROFIT_SHARE",
    "DEPOSIT",
    "EXTERNAL_FUNDING",
    "INTERNAL_TRANSFER",
    "REVERSAL",
    "REFUND",
)


def _check() -> str:
    values = ", ".join(f"'{value}'" for value in _ATTRIBUTES)
    return f"accounting_attribute IN ({values})"


def upgrade() -> None:
    op.drop_constraint(
        "cashflow_accounting_attribute_valid",
        "cashflow",
        type_="check",
    )
    op.create_check_constraint(
        "cashflow_accounting_attribute_valid",
        "cashflow",
        _check(),
    )


def downgrade() -> None:
    legacy = tuple(value for value in _ATTRIBUTES if value != "PROFIT_SHARE")
    values = ", ".join(f"'{value}'" for value in legacy)
    op.drop_constraint(
        "cashflow_accounting_attribute_valid",
        "cashflow",
        type_="check",
    )
    op.create_check_constraint(
        "cashflow_accounting_attribute_valid",
        "cashflow",
        f"accounting_attribute IN ({values})",
    )
