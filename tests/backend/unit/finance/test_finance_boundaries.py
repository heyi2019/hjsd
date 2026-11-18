"""CASHFLOW-02 资金中心边界：业务口径由 finance 后端统一负责。"""

import importlib

import pytest

from app.finance.schemas import CashflowCreate


def test_finance_router_only_exposes_the_composed_router() -> None:
    finance_router = importlib.import_module("app.finance.router")

    assert finance_router.__all__ == ["router"]
    assert not hasattr(finance_router, "create_cashflow")
    assert not hasattr(finance_router, "list_deposits")
    assert not hasattr(finance_router, "update_rebate")


def test_manual_cashflow_request_accepts_minimal_payload() -> None:
    payload = CashflowCreate(
        pool_id=1,
        occurred_on="2026-11-16",
        direction="IN",
        accounting_attribute="SELF_REVENUE",
        category="OTHER",
        amount="1.00",
    )


def test_pool_balance_projection_belongs_to_finance() -> None:
    importlib.import_module("app.finance.balances")
    assert importlib.util.find_spec("app.orders.pools") is None
