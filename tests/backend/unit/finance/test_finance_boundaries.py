"""CASHFLOW-02 资金中心边界：业务口径由 finance 后端统一负责。"""

import importlib

import pytest

from app.finance.attributes import derive_manual_cashflow_nature
from app.finance.schemas import CashflowCreate


@pytest.mark.parametrize(
    ("fund_nature", "direction", "expected"),
    [
        ("EXTERNAL", "IN", "EXTERNAL_IN"),
        ("EXTERNAL", "OUT", "BUSINESS_OUT"),
        ("INTERNAL", "IN", "BUSINESS_IN"),
        ("INTERNAL", "OUT", "BUSINESS_OUT"),
        ("BUSINESS", "IN", "BUSINESS_IN"),
        ("BUSINESS", "OUT", "BUSINESS_OUT"),
    ],
)
def test_manual_cashflow_nature_is_derived_by_finance(
    fund_nature: str, direction: str, expected: str
) -> None:
    assert derive_manual_cashflow_nature(fund_nature, direction) == expected


def test_finance_router_only_exposes_the_composed_router() -> None:
    finance_router = importlib.import_module("app.finance.router")

    assert finance_router.__all__ == ["router"]
    assert not hasattr(finance_router, "create_cashflow")
    assert not hasattr(finance_router, "list_deposits")
    assert not hasattr(finance_router, "update_rebate")


def test_manual_cashflow_request_does_not_require_derived_nature() -> None:
    payload = CashflowCreate(
        pool_id=1,
        occurred_on="2026-11-16",
        direction="IN",
        fund_nature="BUSINESS",
        accounting_attribute="SELF_REVENUE",
        category="OTHER",
        amount="1.00",
    )

    assert payload.nature is None


def test_pool_balance_projection_belongs_to_finance() -> None:
    importlib.import_module("app.finance.balances")
    assert importlib.util.find_spec("app.orders.pools") is None
