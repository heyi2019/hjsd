"""API-01 finance.router 直接契约测试：覆盖受限用户可见性分支与端点主路径。

直接调用 router 模块里的端点函数（绕过 FastAPI 依赖注入），用受限 CurrentUser
触发池可见性拦截，用全范围用户走通主路径，从而把 router.py 的行覆盖推满。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.business.inventory.profile import create_account
from app.core.errors import NotFound
from app.core.security import CurrentUser
from app.funds.deposits.writes import create_deposit
from app.funds import rebates
from app.funds import schemas
from app.funds.routers.cashflows_router import list_cashflows
from app.funds.routers.deposits_router import cancel_deposit, lose_deposit, return_deposit
from app.funds.routers.rebates_router import get_rebate
from app.funds.routers.reconciliation_router import (
    create_reconciliation,
    list_reconciliations,
    repair_transfer,
)
from app.business.create import create_order
from app.business.events import post_event


TODAY = date(2026, 10, 17)


def test_cancel_deposit_endpoint_rejects_unknown_deposit(seeded_db):
    with pytest.raises(NotFound, match="押金不存在"):
        cancel_deposit(
            999999, schemas.DepositCancel(cancelled_on=TODAY, reason="x"),
            db=seeded_db, user=_all_scope_user(),
        )


def test_cancel_deposit_endpoint_returns_cancelled_deposit(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    out = cancel_deposit(
        deposit.id,
        schemas.DepositCancel(cancelled_on=TODAY, reason="x", operator_user_ids=[1]),
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
    result = list_cashflows(pool_id=1, db=seeded_db, user=_restricted_user())
    assert result.items == []
    assert result.total == 0


def test_router_list_cashflows_empty_pool_ids(seeded_db):
    result = list_cashflows(pool_id=None, db=seeded_db, user=_restricted_user())
    assert result.items == []
    assert result.total == 0


# ----------------------------------------------------- list_reconciliations 可见性
def test_router_list_reconciliations_pool_id_not_visible(seeded_db):
    assert list_reconciliations(pool_id=1, db=seeded_db, user=_restricted_user()) == []


# ----------------------------------------------------- create_reconciliation 可见性
def test_router_create_reconciliation_pool_not_visible(seeded_db):
    with pytest.raises(NotFound):
        create_reconciliation(
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
        repair_transfer(
            "NOSUCH",
            payload=schemas.TransferRepair(counterpart_pool_id=1, reason="x"),
            db=seeded_db,
            user=_restricted_user(),
        )


# ----------------------------------------------------- return/lose_deposit 不存在与越权
def test_router_return_deposit_not_found(seeded_db):
    with pytest.raises(NotFound):
        return_deposit(
            999999,
            payload=schemas.DepositReturn(amount=Decimal("1"), released_on=TODAY),
            db=seeded_db,
            user=_all_scope_user(),
        )


def test_router_return_deposit_not_visible(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(NotFound):
        return_deposit(
            deposit.id,
            payload=schemas.DepositReturn(amount=Decimal("1"), released_on=TODAY),
            db=seeded_db,
            user=_restricted_user(),
        )


def test_router_lose_deposit_not_found(seeded_db):
    with pytest.raises(NotFound):
        lose_deposit(
            999999,
            payload=schemas.DepositLoss(
                amount=Decimal("1"), lost_on=TODAY, category="OTHER", reason="x"
            ),
            db=seeded_db,
            user=_all_scope_user(),
        )


def test_router_lose_deposit_not_visible(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(NotFound):
        lose_deposit(
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
        amount=Decimal("1000"),
        collected_on=TODAY,
        operator_user_ids=[1],
        actor="pytest",
    )
    result = get_rebate(record.id, db=seeded_db, user=_all_scope_user())
    assert result.rebate_no == record.rebate_no
    assert result.operator_user_ids == [1]


# ----------------------------------------------------- settle_rebate 记录不存在


# ----------------------------------------------------- cashflows_router 补口
from app.core.errors import Validation  # noqa: E402
from app.domain.enums import CashflowLedgerType  # noqa: E402
from app.funds import cashflows as cashflow_service  # noqa: E402
from app.funds.routers.cashflows_router import (  # noqa: E402
    create_order_cashflow,
    delete_cashflow as delete_cashflow_endpoint,
    list_cashflow_totals,
    update_cashflow as update_cashflow_endpoint,
)


def _pool1_user() -> CurrentUser:
    return CurrentUser(
        id=888,
        username="pool1only",
        roles=(),
        permissions=frozenset(),
        pool_ids=frozenset({1}),
        owner_scope="SELF",
    )


def test_router_list_cashflow_totals_pool_not_visible(seeded_db):
    totals = list_cashflow_totals(pool_id=1, db=seeded_db, user=_restricted_user())
    assert totals.total_in == Decimal("0")
    assert totals.total_out == Decimal("0")


def test_router_list_cashflow_totals_empty_pool_ids(seeded_db):
    totals = list_cashflow_totals(pool_id=None, db=seeded_db, user=_restricted_user())
    assert totals.total_in == Decimal("0")
    assert totals.total_out == Decimal("0")


def test_router_list_cashflow_totals_scoped_pool_ids(seeded_db):
    cashflow_service.create_cashflow(
        seeded_db, pool_id=1, occurred_on=TODAY,
        direction="IN", category="客户收款",
        amount=Decimal("80"), actor="pytest", note="合计可见性",
    )
    totals = list_cashflow_totals(
        pool_id=None, db=seeded_db, user=_pool1_user(),
        order_id=None, direction=None, occurred_from=None, occurred_to=None,
        ledger_type=None, accounting_attribute=None, category=None,
        created_by=None, keyword=None,
    )
    assert totals.total_in == Decimal("80")


def test_router_list_cashflow_totals_main_path(seeded_db):
    cashflow_service.create_cashflow(
        seeded_db, pool_id=1, occurred_on=TODAY,
        direction="IN", category="客户收款",
        amount=Decimal("100"), actor="pytest", note="端点合计",
    )
    cashflow_service.create_cashflow(
        seeded_db, pool_id=1, occurred_on=TODAY,
        direction="OUT", category="OTHER",
        amount=Decimal("30"), actor="pytest",
    )
    totals = list_cashflow_totals(
        pool_id=None, db=seeded_db, user=_all_scope_user(),
        order_id=None, direction=None, occurred_from=None, occurred_to=None,
        ledger_type=None, accounting_attribute=None, category=None,
        created_by=None, keyword=None,
    )
    assert totals.total_in == Decimal("100")
    assert totals.total_out == Decimal("30")


def test_router_create_order_cashflow_rejects_order_mismatch(seeded_db):
    with pytest.raises(Validation, match="资金明细关联订单与路径订单不一致"):
        create_order_cashflow(
            1,
            schemas.CashflowCreate(
                pool_id=1, occurred_on=TODAY, direction="OUT",
                category="OTHER", amount=Decimal("10"), order_id=2,
            ),
            db=seeded_db, user=_all_scope_user(),
        )


def _studio_flow(seeded_db, *, direction="OUT", category="房租", amount="20"):
    return cashflow_service.create_cashflow(
        seeded_db, pool_id=1, occurred_on=TODAY,
        direction=direction,
        category=category, amount=Decimal(amount), actor="pytest",
        ledger_type=CashflowLedgerType.STUDIO.value,
    )


def test_router_update_cashflow_endpoint(seeded_db):
    flow = _studio_flow(seeded_db)
    out = update_cashflow_endpoint(
        flow.id,
        schemas.CashflowUpdate(
            pool_id=1, occurred_on=TODAY, direction="OUT",
            category="房租", amount=Decimal("35"), note="端点编辑",
        ),
        db=seeded_db, user=_all_scope_user(),
    )
    assert out.amount == Decimal("35.00")
    assert out.note == "端点编辑"


def test_router_delete_cashflow_endpoint(seeded_db):
    flow = _studio_flow(seeded_db)
    result = delete_cashflow_endpoint(flow.id, db=seeded_db, user=_all_scope_user())
    assert result is None
    assert seeded_db.get(type(flow), flow.id) is None


# ----------------------------------------------------- 查询层与零头端点补口
from app.domain.trade import Deposit  # noqa: E402
from app.funds.balances import pool_balances  # noqa: E402
from app.funds.cashflow_queries import cashflow_totals, studio_summary  # noqa: E402
from app.funds.routers.deposits_router import (  # noqa: E402
    delete_deposit as delete_deposit_endpoint,
    update_deposit as update_deposit_endpoint,
)
from app.funds.routers.rebates_router import (  # noqa: E402
    update_rebate as update_rebate_endpoint,
)
from app.funds.reconciliation import resolve_reconciliation  # noqa: E402


def test_query_list_cashflows_rejects_bad_ledger_type(seeded_db):
    from app.funds.cashflow_queries import list_cashflows as query_list

    with pytest.raises(Validation, match="ledger_type 必须为"):
        query_list(seeded_db, ledger_type="NOPE")


def test_cashflow_totals_pool_not_visible(seeded_db):
    total_in, total_out = cashflow_totals(
        seeded_db, pool_id=1, user=_restricted_user(),
    )
    assert total_in == Decimal("0")
    assert total_out == Decimal("0")


def test_studio_summary_filters_pool_scope(seeded_db):
    cashflow_service.create_cashflow(
        seeded_db, pool_id=1, occurred_on=TODAY,
        direction="OUT", category="房租",
        amount=Decimal("20"), actor="pytest",
        ledger_type=CashflowLedgerType.STUDIO.value,
    )
    visible = studio_summary(seeded_db, pool_ids=[1, 2], user=_pool1_user())
    assert visible["count"] == 1
    hidden = studio_summary(seeded_db, pool_ids=[9], user=_pool1_user())
    assert hidden["count"] == 0
    assert hidden["income"] == Decimal("0")
    assert hidden["expense"] == Decimal("0")


def test_pool_balances_rejects_unknown_pool(seeded_db):
    # 空 ids 直接返回空表，不查库
    assert pool_balances(seeded_db, []) == {}
    with pytest.raises(NotFound, match="资金账户 999999 不存在"):
        pool_balances(seeded_db, [999999])
    # 池真实存在但用户无权可见：同样拒答
    with pytest.raises(NotFound, match="资金账户 1 不存在"):
        pool_balances(seeded_db, [1], user=_restricted_user())


def test_router_update_rebate_endpoint(seeded_db):
    order_id = _order_with_buy(seeded_db)
    record = rebates.create_rebate(
        seeded_db, source_order_id=order_id, rebate_type="BUY",
        amount=Decimal("800"), collected_on=TODAY, actor="pytest",
    )
    out = update_rebate_endpoint(
        record.id, schemas.RebateUpdate(amount=Decimal("500")),
        db=seeded_db, user=_all_scope_user(),
    )
    assert out.amount == Decimal("500.00")


def test_resolve_reconciliation_with_form_extra(seeded_db):
    from app.funds.routers.reconciliation_router import create_reconciliation

    item = create_reconciliation(
        payload=schemas.ReconciliationCreate(
            pool_id=1, reconciled_on=TODAY, account_label="农行 8678",
            statement_balance=Decimal("100"),
            reason="对账差异待核销", operator_user_ids=[1],
        ),
        db=seeded_db, user=_all_scope_user(),
    )
    resolved = resolve_reconciliation(
        seeded_db, item.id, actor="pytest", reason="已对平",
        form_extra={"差异说明": "无"}, operator_user_ids=[1],
    )
    assert resolved.status == "RESOLVED"
    assert (resolved.form_extra or {}).get("差异说明") == "无"


def test_router_update_deposit_endpoint(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    out = update_deposit_endpoint(
        deposit.id,
        schemas.DepositUpdate(
            pool_id=1, amount=Decimal("120"), paid_on=TODAY,
            operator_user_ids=[1],
        ),
        db=seeded_db, user=_all_scope_user(),
    )
    assert out.paid_amount == Decimal("120.00")


def test_router_delete_deposit_endpoint(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    assert delete_deposit_endpoint(deposit.id, db=seeded_db, user=_all_scope_user()) is None
    assert seeded_db.get(Deposit, deposit.id) is None
