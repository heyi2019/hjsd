"""CASHFLOW-01 现金流与押金服务拆分后的直接契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import NotFound, Validation
from app.shared.numbering import allocate_flow_no
from app.core.security import CurrentUser
from app.domain.enums import CashflowLedgerType, CashflowSourceType
from app.domain.trade import Cashflow
from app.funds import cashflows
from app.funds.deposits.writes import create_deposit, delete_deposit, update_deposit
from app.funds.deposits.lifecycle import cancel_deposit, return_deposit
from app.funds.deposits.reads import deposit_held_total, list_deposits


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
    from app.business.stocks.profile import create_account
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

def test_create_cashflow_order_event_unknown_source_id(seeded_db):
    with pytest.raises(Validation, match="业务事件不存在或不属于该订单"):
        cashflows.create_cashflow(
            seeded_db, pool_id=1, occurred_on=TODAY,
            direction="OUT", category="OTHER",
            amount=Decimal("10"), actor="pytest",
            source_type=CashflowSourceType.ORDER_EVENT.value,
            source_id="SR99999",
        )

def test_create_cashflow_manual_rejects_source_id(seeded_db):
    with pytest.raises(Validation, match="手工流水不能填写 source_id"):
        cashflows.create_cashflow(
            seeded_db, pool_id=1, occurred_on=TODAY,
            direction="OUT", category="OTHER",
            amount=Decimal("10"), actor="pytest", source_id="SR00001",
        )

def test_create_cashflow_studio_ledger_requires_manual_without_order(seeded_db):
    order, event = _order_with_buy_event(seeded_db)
    with pytest.raises(Validation, match="工作室运营账簿必须是无订单归属的手工流水"):
        cashflows.create_cashflow(
            seeded_db, pool_id=1, occurred_on=TODAY,
            direction="OUT", category="OTHER",
            amount=Decimal("10"), actor="pytest",
            ledger_type=CashflowLedgerType.STUDIO.value,
            source_type=CashflowSourceType.ORDER_EVENT.value,
            source_id=event.event_no,
        )

def test_update_cashflow_rejects_non_studio_flow(seeded_db):
    flow = cashflows.create_cashflow(
        seeded_db, pool_id=1, occurred_on=TODAY,
        direction="IN", category="REBATE",
        amount=Decimal("50"), actor="pytest",
    )
    with pytest.raises(Validation, match="仅工作室手工收支可编辑或删除"):
        cashflows.update_cashflow(
            seeded_db, flow.id, pool_id=1, occurred_on=TODAY,
            direction="OUT", category="房租", amount=Decimal("30"),
            actor="pytest",
        )

def test_update_cashflow_rejects_reversed_studio_flow(seeded_db):
    flow = _studio_flow(seeded_db)
    cashflows.reverse_cashflow(
        seeded_db, flow.id, reversed_on=TODAY, actor="pytest", reason="错录",
    )
    with pytest.raises(Validation, match="已冲销的工作室收支不能编辑或删除"):
        cashflows.update_cashflow(
            seeded_db, flow.id, pool_id=1, occurred_on=TODAY,
            direction="OUT", category="房租", amount=Decimal("30"),
            actor="pytest",
        )

def test_delete_cashflow_rejects_non_studio_flow(seeded_db):
    flow = cashflows.create_cashflow(
        seeded_db, pool_id=1, occurred_on=TODAY,
        direction="IN", category="REBATE",
        amount=Decimal("50"), actor="pytest",
    )
    with pytest.raises(Validation, match="仅工作室手工收支可编辑或删除"):
        cashflows.delete_cashflow(seeded_db, flow.id, actor="pytest")


@pytest.mark.parametrize(("direction", "attribute"), [("OUT", "OPERATING_EXPENSE"), ("IN", "SELF_REVENUE")])
def test_studio_actions_reject_business_ledger_cashflows(seeded_client, seeded_db, headers, direction, attribute):
    flow = cashflows.create_cashflow(
        seeded_db, pool_id=1, occurred_on=TODAY, direction=direction,
        ledger_type="BUSINESS", accounting_attribute=attribute, category="房租",
        amount=Decimal("50"), actor="pytest",
    )
    payload = {"pool_id": 1, "occurred_on": TODAY.isoformat(), "direction": direction,
               "accounting_attribute": attribute, "category": "房租", "amount": "80"}
    response = seeded_client.put(f"/api/cashflows/{flow.id}", headers=headers, json=payload)
    assert response.status_code == 422, response.text
    response = seeded_client.delete(f"/api/cashflows/{flow.id}", headers=headers)
    assert response.status_code == 422, response.text
    seeded_db.expire_all()
    saved = seeded_db.get(Cashflow, flow.id)
    assert saved is not None
    assert saved.ledger_type == "BUSINESS"
    assert saved.amount == Decimal("50.00")

def test_update_cashflow_rejects_bad_direction(seeded_db):
    flow = _studio_flow(seeded_db)
    with pytest.raises(Validation, match="direction 必须为"):
        _assert_update_fail(seeded_db, flow, direction="SIDEWAYS")

def test_update_cashflow_rejects_studio_expense_attribute(seeded_db):
    flow = _studio_flow(seeded_db)
    with pytest.raises(Validation, match="工作室支出必须使用运营费用科目"):
        _assert_update_fail(seeded_db, flow, accounting_attribute="SELF_REVENUE")

def test_update_cashflow_rejects_studio_income_attribute(seeded_db):
    flow = _studio_flow(seeded_db)
    with pytest.raises(Validation, match="工作室收入必须使用回收收入科目"):
        _assert_update_fail(
            seeded_db, flow, direction="IN",
            accounting_attribute="OPERATING_EXPENSE",
        )

def test_update_cashflow_rejects_excluded_category(seeded_db):
    flow = _studio_flow(seeded_db)
    with pytest.raises(Validation, match="该科目不属于工作室手工收支"):
        _assert_update_fail(
            seeded_db, flow, category="TRANSFER",
            accounting_attribute="OPERATING_EXPENSE",
        )

def test_update_cashflow_rejects_invisible_pool(seeded_db):
    flow = _studio_flow(seeded_db)
    with pytest.raises(NotFound, match="资金账户不存在"):
        cashflows.update_cashflow(
            seeded_db, flow.id, pool_id=2, occurred_on=TODAY,
            direction="OUT", category="房租", amount=Decimal("30"),
            actor="pytest", user=_pool1_user(),
        )

def test_update_unknown_deposit_not_found(seeded_db):
    with pytest.raises(NotFound, match="押金 999999 不存在"):
        update_deposit(
            seeded_db, 999999, pool_id=1, amount=Decimal("10"),
            paid_on=TODAY, actor="pytest",
        )

def test_update_deposit_rejects_after_return(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    return_deposit(
        seeded_db, deposit.id, amount=Decimal("40"), released_on=TODAY, actor="pytest"
    )
    with pytest.raises(Validation, match="只有未发生退还/损失的押金可编辑或删除"):
        update_deposit(
            seeded_db, deposit.id, pool_id=1, amount=Decimal("10"),
            paid_on=TODAY, actor="pytest",
        )

def test_update_deposit_rejects_invisible_target_pool(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(NotFound, match="资金账户不存在"):
        update_deposit(
            seeded_db, deposit.id, pool_id=2, amount=Decimal("10"),
            paid_on=TODAY, actor="pytest", user=_pool1_user(),
        )

def test_update_deposit_rejects_unknown_counterparty(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(NotFound):
        update_deposit(
            seeded_db, deposit.id, pool_id=1, amount=Decimal("10"),
            paid_on=TODAY, actor="pytest", counterparty_id=999999,
        )

def test_update_deposit_rejects_unknown_source_order(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(NotFound, match="来源订单 999999 不存在"):
        update_deposit(
            seeded_db, deposit.id, pool_id=1, amount=Decimal("10"),
            paid_on=TODAY, actor="pytest", source_order_id=999999,
        )

def test_update_deposit_missing_hold_flow(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    hold = seeded_db.scalar(select(Cashflow).where(
        Cashflow.source_type == CashflowSourceType.DEPOSIT.value,
        Cashflow.source_id == str(deposit.id),
        Cashflow.category == "DEPOSIT_HOLD",
    ))
    seeded_db.delete(hold)
    seeded_db.flush()
    with pytest.raises(Validation, match="押金占用对应流水不存在"):
        update_deposit(
            seeded_db, deposit.id, pool_id=1, amount=Decimal("10"),
            paid_on=TODAY, actor="pytest",
        )

def test_update_deposit_with_form_extra(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    update_deposit(
        seeded_db, deposit.id, pool_id=1, amount=Decimal("120"),
        paid_on=TODAY, actor="pytest", form_extra={"交接说明": "换池"},
    )
    assert (deposit.form_extra or {}).get("交接说明") == "换池"
    assert deposit.paid_amount == Decimal("120")

def test_delete_deposit_rejects_with_subsequent_flows(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    # 状态干净的押金 + 一笔非占用的押金来源流水（模拟历史脏数据/孤儿流水）
    seeded_db.add(Cashflow(
        flow_no=allocate_flow_no(seeded_db, "IN"), pool_id=1, occurred_on=TODAY,
        accounting_attribute="DEPOSIT",
        category="DEPOSIT_RELEASE", direction="IN", amount=Decimal("1"),
        source_type=CashflowSourceType.DEPOSIT.value, source_id=str(deposit.id),
        created_by="pytest", updated_by="pytest",
    ))
    seeded_db.flush()
    with pytest.raises(Validation, match="押金已产生后续资金流水"):
        delete_deposit(seeded_db, deposit.id, actor="pytest")

def test_create_deposit_rejects_unknown_counterparty(seeded_db):
    with pytest.raises(NotFound):
        create_deposit(
            seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY,
            actor="pytest", counterparty_id=999999,
        )

def test_list_deposits_pool_filter_respects_user_scope(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    # pool_id 过滤 + 授权用户可见
    assert list_deposits(seeded_db, pool_id=1, user=_pool1_user()) == [deposit]
    # pool_ids 过滤：只保留授权内的池
    assert list_deposits(seeded_db, pool_ids=[1, 2], user=_pool1_user()) == [deposit]

def test_deposit_held_total_filters_by_pool(seeded_db):
    create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    assert deposit_held_total(seeded_db, pool_id=1) == Decimal("100")
    assert deposit_held_total(seeded_db, pool_id=2) == Decimal("0")

def test_return_deposit_with_form_extra(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    return_deposit(
        seeded_db, deposit.id, amount=Decimal("60"), released_on=TODAY,
        actor="pytest", form_extra={"退还渠道": "支付宝"},
    )
    assert (deposit.form_extra or {}).get("退还渠道") == "支付宝"
    assert deposit.returned_amount == Decimal("60")

def test_cancel_deposit_with_form_extra(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    cancel_deposit(
        seeded_db, deposit.id, cancelled_on=TODAY, reason="登记有误",
        actor="pytest", form_extra={"取消原因补充": "误录池"},
    )
    assert (deposit.form_extra or {}).get("取消原因补充") == "误录池"
    assert deposit.status == "CANCELLED"

def test_deposit_held_total_scoped_for_operator(seeded_db):
    create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    # 只授权池 1 的用户：能看到本池在押合计
    assert deposit_held_total(seeded_db, user=_pool1_user()) == Decimal("100")
    # 无任何池授权的用户：合计为 0
    assert deposit_held_total(seeded_db, user=_restricted_user()) == Decimal("0")
