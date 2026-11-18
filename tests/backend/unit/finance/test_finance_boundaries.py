"""CASHFLOW-02 资金中心边界：业务口径由 finance 后端统一负责。"""

import importlib
from datetime import date
from decimal import Decimal

import pytest

from app.domain.trade import Deposit
from app.finance.deposits._shared import _status_after_loss, _status_after_return
from app.finance.schemas import CashflowCreate
from app.shared.order_amounts import is_deposit_loss_flow


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


def _deposit(paid: str, returned: str = "0", lost: str = "0", status: str = "PAID") -> Deposit:
    return Deposit(
        id=1,
        pool_id=1,
        counterparty_id=1,
        source_order_id=1,
        paid_amount=Decimal(paid),
        returned_amount=Decimal(returned),
        lost_amount=Decimal(lost),
        status=status,
        paid_on=date(2026, 11, 19),
        created_by="pytest",
        updated_by="pytest",
        created_at=date(2026, 11, 19),
        updated_at=date(2026, 11, 19),
    )


def test_status_after_return_full_refund_is_returned() -> None:
    assert _status_after_return(_deposit("300", returned="300")) == "RETURNED"


def test_status_after_return_full_release_with_loss_is_lost() -> None:
    assert _status_after_return(_deposit("300", returned="200", lost="100")) == "LOST"


def test_status_after_return_partial_is_partially_returned() -> None:
    assert _status_after_return(_deposit("300", returned="100")) == "PARTIALLY_RETURNED"


def test_status_after_loss_partial_keeps_original_status() -> None:
    assert _status_after_loss(_deposit("300", returned="100", lost="50", status="PARTIALLY_RETURNED")) == "PARTIALLY_RETURNED"


def test_status_after_loss_full_is_lost() -> None:
    assert _status_after_loss(_deposit("300", returned="250", lost="50")) == "LOST"


@pytest.mark.parametrize(
    ("attribute", "direction", "category", "expected"),
    [
        # 唯一的押金损失流水：DEPOSIT + OUT + 非 HOLD（净额为负重分类，须被聚合排除）
        ("DEPOSIT", "OUT", "DEPOSIT_LOSS", True),
        ("DEPOSIT", "OUT", None, True),
        # 交押金 OUT + HOLD、退押金 IN 都是真实资金流，不是损失
        ("DEPOSIT", "OUT", "DEPOSIT_HOLD", False),
        ("DEPOSIT", "IN", "DEPOSIT_RELEASE", False),
        ("DEPOSIT", "IN", None, False),
        # 非押金属性一律不是押金损失（含 NULL，规避 SQL 三值逻辑误删）
        (None, "OUT", "OTHER", False),
        (None, "OUT", None, False),
        ("SELF_REVENUE", "OUT", "OTHER", False),
        ("DEPOSIT", "IN", "DEPOSIT_HOLD", False),
    ],
)
def test_is_deposit_loss_flow_mirrors_sql_predicate(
    attribute: str | None, direction: str, category: str | None, expected: bool
) -> None:
    """押金损失判定的 Python 版须与 business_cashflow_filter 的排除项严格镜像。

    尤其 attribute=NULL 不得误判为损失——SQL 谓词正向写法正是为规避此三值逻辑陷阱。
    """
    assert is_deposit_loss_flow(
        accounting_attribute=attribute, direction=direction, category=category
    ) is expected
