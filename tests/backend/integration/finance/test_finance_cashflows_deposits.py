"""CASHFLOW-01 现金流与押金服务拆分后的直接契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser
from app.domain.enums import CashflowLedgerType, CashflowSourceType
from app.domain.foundation import Pool
from app.domain.trade import Cashflow
from app.funds import cashflows
from app.funds.cashflow_queries import list_cashflows
from app.funds.deposits.writes import create_deposit
from app.funds.deposits.lifecycle import cancel_deposit, lose_deposit, return_deposit
from app.funds.deposits.reads import list_deposits
from app.funds import transfers


TODAY = date(2026, 10, 17)

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

def _make_flow(seeded_db, *, direction,
               accounting_attribute="OPERATING_EXPENSE", category="OTHER", amount="10",
               note="memo", order_id=None):
    return cashflows.create_cashflow(
        seeded_db,
        pool_id=1,
        occurred_on=TODAY,
        direction=direction,
        accounting_attribute=accounting_attribute,
        category=category,
        amount=Decimal(amount),
        actor="pytest",
        note=note,
        order_id=order_id,
    )

def _make_order(seeded_db, order_type):
    from app.business.create import create_order

    kwargs: dict = {"order_type": order_type, "trade_date": TODAY, "actor": "pytest"}
    if order_type == "DG":
        kwargs["account_snapshot"] = {
            "game_account": "cost-guard-dg-001", "game_type": "王者荣耀",
        }
    return create_order(seeded_db, **kwargs)

def _cashflow_row(**overrides):
    """列表路径的 row dict 形态（`_cashflow_out` 的 dict 分支入参）。"""
    from datetime import datetime

    row = dict(
        id=1, flow_no="ZC00001", pool_id=1, occurred_on=TODAY,
        occurred_at=datetime(2026, 10, 17, 9, 0), ledger_type="BUSINESS", accounting_attribute="SELF_REVENUE",
        category="SALE", direction="IN", amount=Decimal("10"),
        reviewed_by=None, reviewed_at=None, source_type="MANUAL", source_id=None,
        order_id=None, order_no=None,
        note=None, form_extra=None, operator="pytest", created_by="pytest",
    )
    row.update(overrides)
    return row

def _order_with_buy_event(seeded_db):
    from app.business.inventory.profile import create_account
    from app.business.create import create_order
    from app.business.events import post_event

    account = create_account(
        seeded_db, game_account="cf-guard-account",
        business_mode="SELF", inventory_type="RECOVERY", actor="pytest",
    )
    order = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
        account_id=account.id,
    )
    event, _ = post_event(
        seeded_db, order.id, event_type="BUY",
        amount=Decimal("100"), occurred_on=TODAY, actor="pytest", pool_id=1,
    )
    return order, event

def _studio_flow(seeded_db, *, direction="OUT", category="房租", amount="20"):
    return cashflows.create_cashflow(
        seeded_db, pool_id=1, occurred_on=TODAY,
        direction=direction,
        category=category, amount=Decimal(amount), actor="pytest",
        ledger_type=CashflowLedgerType.STUDIO.value,
    )

def _assert_update_fail(seeded_db, flow, **kwargs):
    params = dict(
        pool_id=1, occurred_on=TODAY, direction="OUT", category="房租",
        amount=Decimal("30"), actor="pytest",
    )
    params.update(kwargs)
    return cashflows.update_cashflow(seeded_db, flow.id, **params)

def _pool1_user() -> CurrentUser:
    """只授权池 1 的用户：看得见池 1 流水，改到池 2 时被拒。"""
    return CurrentUser(
        id=888,
        username="pool1only",
        roles=(),
        permissions=frozenset(),
        pool_ids=frozenset({1}),
        owner_scope="SELF",
    )

def test_lose_deposit_rejects_system_category(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(Validation, match="押金损失费用分类不能使用系统分类"):
        lose_deposit(
            seeded_db, deposit.id, amount=Decimal("5"), lost_on=TODAY,
            category="DEPOSIT_HOLD", reason="x", actor="pytest",
        )

def test_list_deposits_user_filter(seeded_db):
    create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    assert list_deposits(seeded_db, pool_id=1, user=_restricted_user()) == []

def test_list_cashflows_user_filter(seeded_db):
    _make_flow(seeded_db, direction="OUT")
    # 无权资金账户一律返回空：明细为空、总数也为 0（返回值恒为 (rows, total) 二元组，
    # 原先这里返回裸 [] 会让调用方解包时报错，只是路由层提前拦住了才没暴露）。
    rows, total = list_cashflows(
        seeded_db, pool_id=1, user=_restricted_user()
    )
    assert rows == [] and total == 0

def test_cashflow_keyword_matches_exact_amount_and_totals(seeded_db):
    from app.funds.cashflow_queries import cashflow_totals
    hit = _make_flow(seeded_db, direction="OUT", amount="5432.10")
    _make_flow(seeded_db, direction="OUT", amount="54321.00")
    rows, total = list_cashflows(seeded_db, keyword="5,432.10")
    assert total == 1
    assert [row["id"] for row in rows] == [hit.id]
    assert cashflow_totals(seeded_db, keyword="5,432.10") == (Decimal("0"), Decimal("5432.10"))

def test_list_cashflows_filters(seeded_db):
    flow = _make_flow(seeded_db, direction="OUT")

    rows, total = list_cashflows(seeded_db, direction="OUT")
    assert total >= 1 and all(r["direction"] == "OUT" for r in rows)

    rows, _ = list_cashflows(seeded_db, occurred_from=TODAY)
    assert any(r["id"] == flow.id for r in rows)
    rows, _ = list_cashflows(seeded_db, occurred_to=TODAY)
    assert any(r["id"] == flow.id for r in rows)

    rows, _ = list_cashflows(seeded_db, accounting_attribute="OPERATING_EXPENSE")
    assert any(r["id"] == flow.id for r in rows)
    rows, _ = list_cashflows(seeded_db, created_by="pytest")
    assert any(r["id"] == flow.id for r in rows)

def test_list_cashflows_transfer_source(seeded_db):
    cashflows.create_cashflow(
        seeded_db,
        pool_id=1,
        occurred_on=TODAY,
        direction="IN",
        accounting_attribute="SELF_REVENUE",
        category="OTHER",
        amount=Decimal("100"),
        actor="pytest",
    )
    transfers.create_transfer(
        seeded_db, source_pool_id=1, target_pool_id=seeded_db.scalar(select(Pool).where(Pool.code == "HJ_PROFIT")).id,
        amount=Decimal("10"), occurred_on=TODAY, actor="pytest",
    )
    rows, total = list_cashflows(seeded_db)
    transfer_rows = [r for r in rows if r["source_type"] == CashflowSourceType.TRANSFER.value]
    assert transfer_rows
    assert all(r["source"] == "TRANSFER" for r in transfer_rows)

def test_reverse_cashflow_out_direction(seeded_db):
    flow = _make_flow(seeded_db, direction="OUT")
    reversal = cashflows.reverse_cashflow(
        seeded_db, flow.id, reversed_on=TODAY, actor="pytest", reason="x"
    )
    assert reversal.direction == "IN"

def test_reverse_cashflow_rejects_already_reversed(seeded_db):
    flow = _make_flow(seeded_db, direction="OUT")
    cashflows.reverse_cashflow(seeded_db, flow.id, reversed_on=TODAY, actor="pytest", reason="x")
    with pytest.raises(Validation, match="该流水已冲销"):
        cashflows.reverse_cashflow(seeded_db, flow.id, reversed_on=TODAY, actor="pytest", reason="x")

def test_list_cashflows_pool_ids_filter(seeded_db):
    _make_flow(seeded_db, direction="OUT")
    rows, total = list_cashflows(seeded_db, pool_ids=[1])
    assert total >= 1 and all(r["pool_id"] == 1 for r in rows)

def test_list_cashflows_user_only_filter(seeded_db):
    _make_flow(seeded_db, direction="OUT")
    rows, total = list_cashflows(seeded_db, user=_restricted_user())
    assert rows == [] and total == 0

def test_list_cashflows_deposit_source(seeded_db):
    create_deposit(seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest")
    rows, _ = list_cashflows(seeded_db)
    deposit_rows = [r for r in rows if r["source_type"] == CashflowSourceType.DEPOSIT.value]
    assert deposit_rows
    assert all(r["source"] == "DEPOSIT" for r in deposit_rows)

def test_return_deposit_rejects_unknown(seeded_db):
    with pytest.raises(NotFound, match="押金 999999 不存在"):
        return_deposit(
            seeded_db, 999999, amount=Decimal("5"), released_on=TODAY, actor="pytest"
        )

def test_return_deposit_rejects_exceeds(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(Validation, match="退还金额超过未释放余额"):
        return_deposit(
            seeded_db, deposit.id, amount=Decimal("20"), released_on=TODAY, actor="pytest"
        )

def test_cancel_paid_deposit_writes_one_reversal(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("300"), paid_on=TODAY, actor="pytest"
    )
    cancelled = cancel_deposit(
        seeded_db, deposit.id, cancelled_on=TODAY, reason="登记有误", actor="pytest"
    )
    rows = seeded_db.scalars(
        select(Cashflow).where(
                Cashflow.source_type == CashflowSourceType.DEPOSIT.value,
                Cashflow.source_id == str(deposit.id),
            Cashflow.category == "DEPOSIT_CANCEL",
        )
    ).all()
    assert cancelled.status == "CANCELLED"
    assert len(rows) == 1
    assert rows[0].amount == deposit.paid_amount

def test_cancel_unknown_deposit_not_found(seeded_db):
    with pytest.raises(NotFound, match="押金.*不存在"):
        cancel_deposit(
            seeded_db, 999999, cancelled_on=TODAY, reason="x", actor="pytest"
        )

def test_cancel_returned_deposit_rejected(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("300"), paid_on=TODAY, actor="pytest"
    )
    return_deposit(
        seeded_db, deposit.id, amount=Decimal("100"), released_on=TODAY, actor="pytest"
    )
    with pytest.raises(Validation):
        cancel_deposit(
            seeded_db, deposit.id, cancelled_on=TODAY,
            reason="已有退还不可取消", actor="pytest",
        )

def test_create_deposit_rejects_negative_amount(seeded_db):
    with pytest.raises(Validation):
        create_deposit(
            seeded_db, pool_id=1, amount=Decimal("-100"), paid_on=TODAY, actor="pytest"
        )

def test_return_deposit_partial(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    returned = return_deposit(
        seeded_db, deposit.id, amount=Decimal("4"), released_on=TODAY, actor="pytest"
    )
    assert returned.status == "PARTIALLY_RETURNED"

def test_lose_deposit_rejects_exceeds(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(Validation, match="损失金额超过未释放余额"):
        lose_deposit(
            seeded_db, deposit.id, amount=Decimal("20"), lost_on=TODAY,
            category="OFFICE", reason="x", actor="pytest",
        )

def test_lose_deposit_marks_lost(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    lost = lose_deposit(
        seeded_db, deposit.id, amount=Decimal("10"), lost_on=TODAY,
        category="OFFICE", reason="x", actor="pytest",
    )
    assert lost.source_type == CashflowSourceType.DEPOSIT.value
    assert lost.source_id == str(deposit.id)

def test_create_deposit_rejects_unknown_source_order(seeded_db):
    with pytest.raises(NotFound, match="来源订单 999999 不存在"):
        create_deposit(
            seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest",
            source_order_id=999999,
        )

def test_list_deposits_user_only_filter(seeded_db):
    create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    assert list_deposits(seeded_db, user=_restricted_user()) == []

def test_list_cashflows_by_pool_id_visible(seeded_db):
    cashflows.create_cashflow(
        seeded_db, pool_id=1, occurred_on=TODAY,
        direction="IN", category="客户收款",
        amount=Decimal("50"), actor="pytest", note="列表可见性测试",
    )
    items, total = list_cashflows(seeded_db, pool_id=1, user=_all_scope_user())
    assert total >= 1
    assert all(item["pool_id"] == 1 for item in items)

def test_cashflow_out_marks_order_event_source(seeded_db):
    """挂了订单事件就必须标 ORDER_EVENT —— 前端据此决定能否跳订单详情。"""
    from app.funds import router_output

    assert router_output._cashflow_out(seeded_db, _cashflow_row(source_type="ORDER_EVENT", source_id="HS0001-EV-BUY-01")).source == (
        "ORDER_EVENT"
    )

def test_cashflow_out_marks_order_event_rebate_source(seeded_db):
    """返点收入流水通过返点订单事件回指来源。"""
    from app.funds import router_output

    out = router_output._cashflow_out(
        seeded_db,
        _cashflow_row(category="REBATE", source_type="ORDER_EVENT", source_id="HS0001-EV-REBATE-01"),
    )
    assert out.source == "ORDER_EVENT"

def test_create_cashflow_rejects_duplicate_operators(seeded_db):
    with pytest.raises(Validation, match="操作人不能重复选择"):
        cashflows.create_cashflow(
            seeded_db, pool_id=1, occurred_on=TODAY,
            direction="OUT", category="OTHER",
            amount=Decimal("10"), actor="pytest",
            operator_user_ids=[1, 1],
        )

def test_create_cashflow_rejects_missing_operator(seeded_db):
    with pytest.raises(Validation, match="所选操作人不存在或已停用"):
        cashflows.create_cashflow(
            seeded_db, pool_id=1, occurred_on=TODAY,
            direction="OUT", category="OTHER",
            amount=Decimal("10"), actor="pytest",
            operator_user_ids=[99999],
        )

def test_create_cashflow_rejects_bad_ledger_type(seeded_db):
    with pytest.raises(Validation, match="ledger_type 必须为"):
        cashflows.create_cashflow(
            seeded_db, pool_id=1, occurred_on=TODAY,
            direction="OUT", category="OTHER",
            amount=Decimal("10"), actor="pytest", ledger_type="NOPE",
        )

def test_create_cashflow_rejects_bad_source_type(seeded_db):
    with pytest.raises(Validation, match="source_type 必须为"):
        cashflows.create_cashflow(
            seeded_db, pool_id=1, occurred_on=TODAY,
            direction="OUT", category="OTHER",
            amount=Decimal("10"), actor="pytest", source_type="NOPE",
        )

def test_create_cashflow_order_event_requires_source_id(seeded_db):
    with pytest.raises(Validation, match="订单事件流水必须填写 source_id"):
        cashflows.create_cashflow(
            seeded_db, pool_id=1, occurred_on=TODAY,
            direction="OUT", category="OTHER",
            amount=Decimal("10"), actor="pytest",
            source_type=CashflowSourceType.ORDER_EVENT.value,
        )
