"""CASHFLOW-01 现金流与押金服务拆分后的直接契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import NotFound, Validation
from app.shared.operation_operators import list_operation_operators
from app.core.security import CurrentUser
from app.domain.enums import CashflowLedgerType, CashflowSourceType
from app.domain.trade import Cashflow, Deposit
from app.finance.cashflow import cashflows
from app.finance.cashflow.queries import list_cashflows
from app.finance.cashflow.cashflows import create_cashflow
from app.finance.deposits.writes import create_deposit, delete_deposit, update_deposit
from app.finance.deposits.lifecycle import lose_deposit, return_deposit


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
               note="memo", order_id=None, ledger_type="BUSINESS"):
    return cashflows.create_cashflow(
        seeded_db,
        pool_id=1,
        occurred_on=TODAY,
        direction=direction,
        ledger_type=ledger_type,
        accounting_attribute=accounting_attribute,
        category=category,
        amount=Decimal(amount),
        actor="pytest",
        note=note,
        order_id=order_id,
    )

def _make_order(seeded_db, order_type):
    from app.business.orders.create import create_order

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
    from app.business.orders.create import create_order
    from app.business.orders.events import post_event

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

def test_cashflows_module_creates_cashflow_without_status(seeded_db):
    flow = cashflows.create_cashflow(
        seeded_db,
        pool_id=1,
        occurred_on=TODAY,
        direction="IN",
        category="客户收款",
        amount=Decimal("180"),
        actor="pytest",
        note="现金流拆分测试",
    )

    assert flow.amount == Decimal("180.00")
    assert not hasattr(flow, "status")
    assert flow.category == "客户收款"

def test_cashflow_uses_unified_source_reference(seeded_db):
    flow = cashflows.create_cashflow(
        seeded_db,
        pool_id=1,
        occurred_on=TODAY,
        direction="OUT",
        category="房租",
        amount=Decimal("300"),
        actor="pytest",
    )

    assert flow.source_type == "MANUAL"
    assert flow.source_id is None

def test_cashflow_has_top_level_ledger_and_can_filter_business_or_studio(seeded_db):
    business = cashflows.create_cashflow(
        seeded_db,
        pool_id=1,
        occurred_on=TODAY,
        direction="OUT",
        category="BUY",
        amount=Decimal("10"),
        actor="pytest",
        ledger_type=CashflowLedgerType.BUSINESS.value,
    )
    studio = cashflows.create_cashflow(
        seeded_db,
        pool_id=1,
        occurred_on=TODAY,
        direction="OUT",
        category="房租",
        amount=Decimal("20"),
        actor="pytest",
        ledger_type=CashflowLedgerType.STUDIO.value,
    )

    assert business.ledger_type == CashflowLedgerType.BUSINESS.value
    assert studio.ledger_type == CashflowLedgerType.STUDIO.value
    rows, total = list_cashflows(
        seeded_db, ledger_type=CashflowLedgerType.STUDIO.value
    )
    assert total == 1
    assert rows[0]["id"] == studio.id

def test_cashflow_and_deposit_entries_come_from_real_modules():
    """2026-11-12 去兼容：finance.service 门面已删，符号直接来自真实模块。"""
    import importlib.util

    assert create_cashflow is cashflows.create_cashflow
    assert create_deposit.__module__ == "app.finance.deposits.writes"
    assert importlib.util.find_spec("app.finance.service") is None

def test_update_deposit_updates_the_linked_hold_cashflow(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )

    updated = update_deposit(
        seeded_db,
        deposit.id,
        pool_id=1,
        amount=Decimal("25"),
        paid_on=date(2026, 10, 18),
        expected_release_on=date(2026, 11, 1),
        note="updated",
        actor="pytest",
    )
    hold = seeded_db.scalar(
        select(Cashflow).where(
            Cashflow.source_type == CashflowSourceType.DEPOSIT.value,
            Cashflow.source_id == str(deposit.id),
            Cashflow.category == "DEPOSIT_HOLD",
        )
    )

    assert updated.paid_amount == Decimal("25.00")
    assert updated.paid_on == date(2026, 10, 18)
    assert updated.note == "updated"
    assert hold is not None
    assert hold.amount == Decimal("25.00")
    assert hold.occurred_on == date(2026, 10, 18)

def test_delete_deposit_preserves_voucher_and_hold_cashflow(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )

    with pytest.raises(Validation, match="押金不能删除，请使用取消"):
        delete_deposit(seeded_db, deposit.id, actor="pytest")

    assert seeded_db.get(Deposit, deposit.id) is not None
    hold = seeded_db.scalar(select(Cashflow).where(
        Cashflow.source_type == CashflowSourceType.DEPOSIT.value,
        Cashflow.source_id == str(deposit.id),
    ))
    assert hold is not None and hold.category == "DEPOSIT_HOLD"

def test_update_studio_cashflow_updates_the_manual_entry(seeded_db):
    flow = _make_flow(
        seeded_db,
        direction="OUT",
        category="房租",
        amount="3000",
        note="10月房租",
        ledger_type="STUDIO",
    )

    updated = cashflows.update_cashflow(
        seeded_db,
        flow.id,
        pool_id=1,
        occurred_on=date(2026, 10, 20),
        direction="OUT",
        accounting_attribute="OPERATING_EXPENSE",
        category="房租",
        amount=Decimal("3200"),
        note="修正后的房租",
        actor="pytest",
    )

    assert updated.amount == Decimal("3200.00")
    assert updated.occurred_on == date(2026, 10, 20)
    assert updated.note == "修正后的房租"

def test_delete_studio_cashflow_preserves_the_manual_entry(seeded_db):
    flow = _make_flow(seeded_db, direction="OUT", category="日用", ledger_type="STUDIO")

    with pytest.raises(Validation, match="资金流水不能删除，请使用冲销"):
        cashflows.delete_cashflow(seeded_db, flow.id, actor="pytest")

    assert seeded_db.get(Cashflow, flow.id) is not None

def test_create_cashflow_rejects_bad_direction(seeded_db):
    with pytest.raises(Validation, match="direction 必须为"):
        _make_flow(seeded_db, direction="SIDEWAYS")

def test_create_cashflow_rejects_user_not_visible(seeded_db):
    with pytest.raises(NotFound, match="资金账户不存在"):
        cashflows.create_cashflow(
            seeded_db,
            pool_id=1,
            occurred_on=TODAY,
            direction="OUT",
            category="OTHER",
            amount=Decimal("10"),
            actor="pytest",
            user=_restricted_user(),
        )

def test_get_cashflow_rejects_unknown(seeded_db):
    with pytest.raises(NotFound):
        cashflows._get_cashflow(seeded_db, 999999)

def test_get_cashflow_rejects_user_not_visible(seeded_db):
    flow = _make_flow(seeded_db, direction="OUT")
    with pytest.raises(NotFound):
        cashflows._get_cashflow(seeded_db, flow.id, user=_restricted_user())

def test_get_cashflow_checks_order_visible(seeded_db):
    from app.business.orders.create import create_order

    order = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest"
    )
    flow = _make_flow(
        seeded_db, direction="OUT", order_id=order.id
    )
    # owner_scope=ALL 的用户既能通过池可见性，又不触发订单 owner 校验
    fetched = cashflows._get_cashflow(seeded_db, flow.id, user=_all_scope_user())
    assert fetched.id == flow.id

def test_order_cashflow_rejects_cost_attribute_on_dg(seeded_db):
    order = _make_order(seeded_db, "DG")
    with pytest.raises(Validation, match="代挂订单无成本科目"):
        _make_flow(
            seeded_db, direction="OUT", accounting_attribute="SELF_DIRECT_COST", order_id=order.id,
        )

def test_order_cashflow_rejects_mismatched_cost_attribute(seeded_db):
    hs = _make_order(seeded_db, "HS")
    with pytest.raises(Validation, match="成本科目与订单类型不匹配"):
        _make_flow(
            seeded_db, direction="OUT", accounting_attribute="TH_DIRECT_COST", order_id=hs.id,
        )
    th = _make_order(seeded_db, "TH")
    with pytest.raises(Validation, match="成本科目与订单类型不匹配"):
        _make_flow(
            seeded_db, direction="OUT", accounting_attribute="SELF_DIRECT_COST", order_id=th.id,
        )

def test_order_cashflow_allows_matching_cost_attribute(seeded_db):
    hs = _make_order(seeded_db, "HS")
    hs_flow = _make_flow(
        seeded_db, direction="OUT", accounting_attribute="SELF_DIRECT_COST", order_id=hs.id,
    )
    assert hs_flow.accounting_attribute == "SELF_DIRECT_COST"
    th = _make_order(seeded_db, "TH")
    th_flow = _make_flow(
        seeded_db, direction="OUT", accounting_attribute="TH_DIRECT_COST", order_id=th.id,
    )
    assert th_flow.accounting_attribute == "TH_DIRECT_COST"

def test_order_cashflow_allows_non_cost_attributes_on_dg(seeded_db):
    """DG 与回收/提号同权：非成本科目一视同仁；挂单默认落其他收支（非运营支出）。"""
    order = _make_order(seeded_db, "DG")
    out_flow = _make_flow(
        seeded_db, direction="OUT", order_id=order.id,
        accounting_attribute=None,
    )
    assert out_flow.accounting_attribute == "OTHER_EXPENSE"
    in_flow = _make_flow(
        seeded_db, direction="IN", order_id=order.id,
        accounting_attribute=None,
    )
    assert in_flow.accounting_attribute == "OTHER_INCOME"

def test_reverse_cashflow_rejects_deposit_flow(seeded_db):
    from sqlalchemy import select

    from app.domain.trade import Cashflow

    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    flow = seeded_db.scalar(select(Cashflow).where(
        Cashflow.source_type == CashflowSourceType.DEPOSIT.value,
        Cashflow.source_id == str(deposit.id),
    ))
    with pytest.raises(Validation, match="押金或划转现金流必须通过原业务流程冲销"):
        cashflows.reverse_cashflow(
            seeded_db, flow.id, reversed_on=TODAY, actor="pytest", reason="x"
        )


def test_create_deposit_rejects_user_not_visible(seeded_db):
    with pytest.raises(NotFound, match="资金账户不存在"):
        create_deposit(
            seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest",
            user=_restricted_user(),
        )

def test_return_deposit_rejects_user_not_visible(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(NotFound, match="押金 1 不存在"):
        return_deposit(
            seeded_db, deposit.id, amount=Decimal("5"), released_on=TODAY, actor="pytest",
            user=_restricted_user(),
        )

def test_return_deposit_marks_lost(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    lose_deposit(
        seeded_db, deposit.id, amount=Decimal("30"), lost_on=TODAY,
        category="OFFICE", reason="x", actor="pytest",
    )
    returned = return_deposit(
        seeded_db, deposit.id, amount=Decimal("70"), released_on=TODAY, actor="pytest"
    )
    assert returned.status == "LOST"

def test_deposit_actions_persist_action_operators(seeded_db):
    deposit = create_deposit(
        seeded_db,
        pool_id=1,
        amount=Decimal("100"),
        paid_on=TODAY,
        actor="pytest",
        operator_user_ids=[1, 2],
    )
    return_deposit(
        seeded_db,
        deposit.id,
        amount=Decimal("20"),
        released_on=TODAY,
        actor="pytest",
        operator_user_ids=[2],
    )

    rows = list_operation_operators(
        seeded_db,
        entity_type="deposit",
        entity_id=deposit.id,
    )

    assert {row.operation_key: row.operator_user_ids for row in rows} == {
        "CREATE": [1, 2],
        "RELEASE": [2],
    }

def test_lose_deposit_rejects_user_not_visible(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(NotFound, match="押金 1 不存在"):
        lose_deposit(
            seeded_db, deposit.id, amount=Decimal("5"), lost_on=TODAY,
            category="OFFICE", reason="x", actor="pytest", user=_restricted_user(),
        )
