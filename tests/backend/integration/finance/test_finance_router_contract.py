"""API-01 finance.router 直接契约测试：覆盖受限用户可见性分支与端点主路径。

直接调用 router 模块里的端点函数（绕过 FastAPI 依赖注入），用受限 CurrentUser
触发池可见性拦截，用全范围用户走通主路径，从而把 router.py 的行覆盖推满。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.stocks.profile import create_account
from app.core.errors import NotFound
from app.core.security import CurrentUser
from app.finance import deposits
from app.finance import rebates
from app.finance import router as finance_router
from app.finance import schemas
from app.orders.create import create_order
from app.orders.events import post_event


TODAY = date(2026, 10, 17)


def test_cancel_deposit_endpoint_rejects_unknown_deposit(seeded_db):
    with pytest.raises(NotFound, match="押金不存在"):
        finance_router.cancel_deposit(
            999999, schemas.DepositCancel(cancelled_on=TODAY, reason="x"),
            db=seeded_db, user=_all_scope_user(),
        )


def test_cancel_deposit_endpoint_returns_cancelled_deposit(seeded_db):
    deposit = deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    out = finance_router.cancel_deposit(
        deposit.id, schemas.DepositCancel(cancelled_on=TODAY, reason="x"),
        db=seeded_db, user=_all_scope_user(),
    )
    assert out.id == deposit.id
    assert out.status == "CANCELLED"


def _restricted_user() -> CurrentUser:
    return CurrentUser(
        id=999,
        username="restricted",
        roles=(),
        permissions=frozenset(),
        pool_ids=frozenset(),
        owner_scope="SELF",
    )


def _all_scope_user() -> CurrentUser:
    return CurrentUser(
        id=1,
        username="allscope",
        roles=(),
        owner_scope="ALL",
        pool_ids=frozenset(),
    )


def _order_with_buy(seeded_db) -> int:
    account = create_account(
        seeded_db,
        game_account="router-rebate-account",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    order = create_order(
        seeded_db,
        order_type="HS",
        trade_date=TODAY,
        actor="pytest",
        account_id=account.id,
    )
    post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal("1000"),
        occurred_on=TODAY,
        actor="pytest",
        pool_id=1,
    )
    return order.id


# ----------------------------------------------------- list_cashflows 可见性
def test_router_list_cashflows_pool_id_not_visible(seeded_db):
    result = finance_router.list_cashflows(pool_id=1, db=seeded_db, user=_restricted_user())
    assert result.items == []
    assert result.total == 0


def test_router_list_cashflows_empty_pool_ids(seeded_db):
    result = finance_router.list_cashflows(pool_id=None, db=seeded_db, user=_restricted_user())
    assert result.items == []
    assert result.total == 0


# ----------------------------------------------------- list_reconciliations 可见性
def test_router_list_reconciliations_pool_id_not_visible(seeded_db):
    assert finance_router.list_reconciliations(pool_id=1, db=seeded_db, user=_restricted_user()) == []


# ----------------------------------------------------- create_reconciliation 可见性
def test_router_create_reconciliation_pool_not_visible(seeded_db):
    with pytest.raises(NotFound):
        finance_router.create_reconciliation(
            payload=schemas.ReconciliationCreate(
                pool_id=1,
                reconciled_on=TODAY,
                account_label="测试户",
                statement_balance=Decimal("0"),
            ),
            db=seeded_db,
            user=_restricted_user(),
        )


# ----------------------------------------------------- repair_transfer 对端池不可见
def test_router_repair_transfer_counterpart_not_visible(seeded_db):
    with pytest.raises(NotFound):
        finance_router.repair_transfer(
            "NOSUCH",
            payload=schemas.TransferRepair(counterpart_pool_id=1, reason="x"),
            db=seeded_db,
            user=_restricted_user(),
        )


# ----------------------------------------------------- return/lose_deposit 不存在与越权
def test_router_return_deposit_not_found(seeded_db):
    with pytest.raises(NotFound):
        finance_router.return_deposit(
            999999,
            payload=schemas.DepositReturn(amount=Decimal("1"), released_on=TODAY),
            db=seeded_db,
            user=_all_scope_user(),
        )


def test_router_return_deposit_not_visible(seeded_db):
    deposit = deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(NotFound):
        finance_router.return_deposit(
            deposit.id,
            payload=schemas.DepositReturn(amount=Decimal("1"), released_on=TODAY),
            db=seeded_db,
            user=_restricted_user(),
        )


def test_router_lose_deposit_not_found(seeded_db):
    with pytest.raises(NotFound):
        finance_router.lose_deposit(
            999999,
            payload=schemas.DepositLoss(
                amount=Decimal("1"), lost_on=TODAY, category="OTHER", reason="x"
            ),
            db=seeded_db,
            user=_all_scope_user(),
        )


def test_router_lose_deposit_not_visible(seeded_db):
    deposit = deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(NotFound):
        finance_router.lose_deposit(
            deposit.id,
            payload=schemas.DepositLoss(
                amount=Decimal("1"), lost_on=TODAY, category="OTHER", reason="x"
            ),
            db=seeded_db,
            user=_restricted_user(),
        )


# ----------------------------------------------------- get_rebate 主路径
def test_router_get_rebate_endpoint(seeded_db):
    record = rebates.create_rebate(
        seeded_db,
        source_order_id=_order_with_buy(seeded_db),
        rebate_type="BUY",
        base_amount=Decimal("1000"),
        rate=Decimal("5"),
        collected_on=TODAY,
        operator_user_ids=[1],
        actor="pytest",
    )
    result = finance_router.get_rebate(record.id, db=seeded_db, user=_all_scope_user())
    assert result.rebate_no == record.rebate_no
    assert result.operator_user_ids == [1]


# ----------------------------------------------------- settle_rebate 记录不存在
