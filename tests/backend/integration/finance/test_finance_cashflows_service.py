"""CASHFLOW-01 现金流与押金服务拆分后的直接契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import NotFound, Validation
from app.core.operation_operators import list_operation_operators
from app.core.security import CurrentUser
from app.domain.enums import CashflowLedgerType, CashflowSourceType
from app.domain.foundation import Pool
from app.domain.trade import Cashflow, Deposit
from app.finance import cashflows, deposits
from app.finance.cashflows import create_cashflow
from app.finance.deposits import create_deposit
from app.finance import transfers


TODAY = date(2026, 10, 17)


def test_cashflows_module_creates_cashflow_without_status(seeded_db):
    flow = cashflows.create_cashflow(
        seeded_db,
        pool_id=1,
        occurred_on=TODAY,
        direction="IN",
        nature="EXTERNAL_IN",
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
        nature="BUSINESS_OUT",
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
        nature="BUSINESS_OUT",
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
        nature="BUSINESS_OUT",
        category="房租",
        amount=Decimal("20"),
        actor="pytest",
        ledger_type=CashflowLedgerType.STUDIO.value,
    )

    assert business.ledger_type == CashflowLedgerType.BUSINESS.value
    assert studio.ledger_type == CashflowLedgerType.STUDIO.value
    rows, total = cashflows.list_cashflows(
        seeded_db, ledger_type=CashflowLedgerType.STUDIO.value
    )
    assert total == 1
    assert rows[0]["id"] == studio.id


def test_cashflow_and_deposit_entries_come_from_real_modules():
    """2026-11-12 去兼容：finance.service 门面已删，符号直接来自真实模块。"""
    import importlib.util

    assert create_cashflow is cashflows.create_cashflow
    assert create_deposit is deposits.create_deposit
    assert importlib.util.find_spec("app.finance.service") is None


def test_update_deposit_updates_the_linked_hold_cashflow(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )

    updated = deposits.update_deposit(
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


def test_delete_deposit_removes_its_hold_cashflow(seeded_db):
    deposit = create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )

    deposits.delete_deposit(seeded_db, deposit.id, actor="pytest")

    assert seeded_db.get(Deposit, deposit.id) is None
    assert seeded_db.scalar(select(Cashflow).where(
        Cashflow.source_type == CashflowSourceType.DEPOSIT.value,
        Cashflow.source_id == str(deposit.id),
    )) is None


def test_update_studio_cashflow_updates_the_manual_entry(seeded_db):
    flow = _make_flow(
        seeded_db,
        direction="OUT",
        nature="BUSINESS_OUT",
        category="房租",
        amount="3000",
        note="10月房租",
    )

    updated = cashflows.update_cashflow(
        seeded_db,
        flow.id,
        pool_id=1,
        occurred_on=date(2026, 10, 20),
        direction="OUT",
        nature="BUSINESS_OUT",
        accounting_attribute="OPERATING_EXPENSE",
        category="房租",
        amount=Decimal("3200"),
        note="修正后的房租",
        actor="pytest",
    )

    assert updated.amount == Decimal("3200.00")
    assert updated.occurred_on == date(2026, 10, 20)
    assert updated.note == "修正后的房租"


def test_delete_studio_cashflow_removes_the_manual_entry(seeded_db):
    flow = _make_flow(seeded_db, direction="OUT", nature="BUSINESS_OUT", category="日用")

    cashflows.delete_cashflow(seeded_db, flow.id, actor="pytest")

    assert seeded_db.get(Cashflow, flow.id) is None


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


def _make_flow(seeded_db, *, direction, nature,
               accounting_attribute="OPERATING_EXPENSE", category="OTHER", amount="10",
               note="memo", order_id=None):
    return cashflows.create_cashflow(
        seeded_db,
        pool_id=1,
        occurred_on=TODAY,
        direction=direction,
        nature=nature,
        accounting_attribute=accounting_attribute,
        category=category,
        amount=Decimal(amount),
        actor="pytest",
        note=note,
        order_id=order_id,
    )


# ----------------------------------------------------------- create_cashflow 校验


def test_create_cashflow_rejects_bad_direction(seeded_db):
    with pytest.raises(Validation, match="direction 必须为"):
        _make_flow(seeded_db, direction="SIDEWAYS", nature="BUSINESS_OUT")


def test_create_cashflow_rejects_bad_nature(seeded_db):
    with pytest.raises(Validation, match="nature 必须为"):
        _make_flow(seeded_db, direction="OUT", nature="NOPE")


def test_create_cashflow_rejects_internal(seeded_db):
    with pytest.raises(Validation, match="独立现金流不能使用 INTERNAL"):
        _make_flow(seeded_db, direction="OUT", nature="INTERNAL")


def test_create_cashflow_rejects_in_nature_mismatch(seeded_db):
    with pytest.raises(Validation, match="收入流水的 nature 不匹配"):
        _make_flow(seeded_db, direction="IN", nature="BUSINESS_OUT")


def test_create_cashflow_rejects_out_nature_mismatch(seeded_db):
    with pytest.raises(Validation, match="支出流水的 nature 不匹配"):
        _make_flow(seeded_db, direction="OUT", nature="BUSINESS_IN")


def test_create_cashflow_rejects_external_in_without_note(seeded_db):
    with pytest.raises(Validation, match="独立收款必须填写摘要"):
        cashflows.create_cashflow(
            seeded_db,
            pool_id=1,
            occurred_on=TODAY,
            direction="IN",
            nature="EXTERNAL_IN",
            category="OTHER",
            amount=Decimal("10"),
            actor="pytest",
            note=None,
        )


def test_create_cashflow_rejects_user_not_visible(seeded_db):
    with pytest.raises(NotFound, match="资金账户不存在"):
        cashflows.create_cashflow(
            seeded_db,
            pool_id=1,
            occurred_on=TODAY,
            direction="OUT",
            nature="BUSINESS_OUT",
            category="OTHER",
            amount=Decimal("10"),
            actor="pytest",
            user=_restricted_user(),
        )


def test_get_cashflow_rejects_unknown(seeded_db):
    with pytest.raises(NotFound):
        cashflows._get_cashflow(seeded_db, 999999)


def test_get_cashflow_rejects_user_not_visible(seeded_db):
    flow = _make_flow(seeded_db, direction="OUT", nature="BUSINESS_OUT")
    with pytest.raises(NotFound):
        cashflows._get_cashflow(seeded_db, flow.id, user=_restricted_user())


def test_get_cashflow_checks_order_visible(seeded_db):
    from app.orders.create import create_order

    order = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest"
    )
    flow = _make_flow(
        seeded_db, direction="OUT", nature="BUSINESS_OUT", order_id=order.id
    )
    # owner_scope=ALL 的用户既能通过池可见性，又不触发订单 owner 校验
    fetched = cashflows._get_cashflow(seeded_db, flow.id, user=_all_scope_user())
    assert fetched.id == flow.id


# ----------------------------------------------------------- reverse


def test_reverse_cashflow_rejects_deposit_flow(seeded_db):
    from sqlalchemy import select

    from app.domain.trade import Cashflow

    deposit = deposits.create_deposit(
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


def test_reverse_cashflow_in_direction(seeded_db):
    flow = _make_flow(seeded_db, direction="IN", nature="BUSINESS_IN")
    reversal = cashflows.reverse_cashflow(
        seeded_db, flow.id, reversed_on=TODAY, actor="pytest", reason="x"
    )
    assert reversal.direction == "OUT"
    assert reversal.nature == "BUSINESS_OUT"


# ----------------------------------------------------------- 押金


def test_create_deposit_rejects_user_not_visible(seeded_db):
    with pytest.raises(NotFound, match="资金账户不存在"):
        deposits.create_deposit(
            seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest",
            user=_restricted_user(),
        )


def test_return_deposit_rejects_user_not_visible(seeded_db):
    deposit = deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(NotFound, match="押金 1 不存在"):
        deposits.return_deposit(
            seeded_db, deposit.id, amount=Decimal("5"), released_on=TODAY, actor="pytest",
            user=_restricted_user(),
        )


def test_return_deposit_marks_lost(seeded_db):
    deposit = deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    deposits.lose_deposit(
        seeded_db, deposit.id, amount=Decimal("30"), lost_on=TODAY,
        category="OFFICE", reason="x", actor="pytest",
    )
    returned = deposits.return_deposit(
        seeded_db, deposit.id, amount=Decimal("70"), released_on=TODAY, actor="pytest"
    )
    assert returned.status == "LOST"


def test_deposit_actions_persist_action_operators(seeded_db):
    deposit = deposits.create_deposit(
        seeded_db,
        pool_id=1,
        amount=Decimal("100"),
        paid_on=TODAY,
        actor="pytest",
        operator_user_ids=[1, 2],
    )
    deposits.return_deposit(
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
    deposit = deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(NotFound, match="押金 1 不存在"):
        deposits.lose_deposit(
            seeded_db, deposit.id, amount=Decimal("5"), lost_on=TODAY,
            category="OFFICE", reason="x", actor="pytest", user=_restricted_user(),
        )


def test_lose_deposit_rejects_system_category(seeded_db):
    deposit = deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(Validation, match="押金损失费用分类不能使用系统分类"):
        deposits.lose_deposit(
            seeded_db, deposit.id, amount=Decimal("5"), lost_on=TODAY,
            category="DEPOSIT_HOLD", reason="x", actor="pytest",
        )


# ----------------------------------------------------------- list


def test_list_deposits_user_filter(seeded_db):
    deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    assert deposits.list_deposits(seeded_db, pool_id=1, user=_restricted_user()) == []


def test_list_cashflows_user_filter(seeded_db):
    _make_flow(seeded_db, direction="OUT", nature="BUSINESS_OUT")
    # 无权资金账户一律返回空：明细为空、总数也为 0（返回值恒为 (rows, total) 二元组，
    # 原先这里返回裸 [] 会让调用方解包时报错，只是路由层提前拦住了才没暴露）。
    rows, total = cashflows.list_cashflows(
        seeded_db, pool_id=1, user=_restricted_user()
    )
    assert rows == [] and total == 0


def test_list_cashflows_filters(seeded_db):
    flow = _make_flow(seeded_db, direction="OUT", nature="BUSINESS_OUT")

    rows, total = cashflows.list_cashflows(seeded_db, direction="OUT")
    assert total >= 1 and all(r["direction"] == "OUT" for r in rows)

    rows, _ = cashflows.list_cashflows(seeded_db, occurred_from=TODAY)
    assert any(r["id"] == flow.id for r in rows)
    rows, _ = cashflows.list_cashflows(seeded_db, occurred_to=TODAY)
    assert any(r["id"] == flow.id for r in rows)

    rows, _ = cashflows.list_cashflows(seeded_db, accounting_attribute="OPERATING_EXPENSE")
    assert any(r["id"] == flow.id for r in rows)
    rows, _ = cashflows.list_cashflows(seeded_db, created_by="pytest")
    assert any(r["id"] == flow.id for r in rows)


def test_list_cashflows_transfer_source(seeded_db):
    cashflows.create_cashflow(
        seeded_db,
        pool_id=1,
        occurred_on=TODAY,
        direction="IN",
        nature="BUSINESS_IN",
        accounting_attribute="SELF_REVENUE",
        category="OTHER",
        amount=Decimal("100"),
        actor="pytest",
    )
    transfers.create_transfer(
        seeded_db, source_pool_id=1, target_pool_id=seeded_db.scalar(select(Pool).where(Pool.code == "HJ_PROFIT")).id,
        amount=Decimal("10"), occurred_on=TODAY, actor="pytest",
    )
    rows, total = cashflows.list_cashflows(seeded_db)
    transfer_rows = [r for r in rows if r["source_type"] == CashflowSourceType.TRANSFER.value]
    assert transfer_rows
    assert all(r["source"] == "TRANSFER" for r in transfer_rows)


def test_reverse_cashflow_out_direction(seeded_db):
    flow = _make_flow(seeded_db, direction="OUT", nature="BUSINESS_OUT")
    reversal = cashflows.reverse_cashflow(
        seeded_db, flow.id, reversed_on=TODAY, actor="pytest", reason="x"
    )
    assert reversal.direction == "IN"
    assert reversal.nature == "BUSINESS_IN"


def test_reverse_cashflow_rejects_already_reversed(seeded_db):
    flow = _make_flow(seeded_db, direction="OUT", nature="BUSINESS_OUT")
    cashflows.reverse_cashflow(seeded_db, flow.id, reversed_on=TODAY, actor="pytest", reason="x")
    with pytest.raises(Validation, match="该流水已冲销"):
        cashflows.reverse_cashflow(seeded_db, flow.id, reversed_on=TODAY, actor="pytest", reason="x")


def test_list_cashflows_pool_ids_filter(seeded_db):
    _make_flow(seeded_db, direction="OUT", nature="BUSINESS_OUT")
    rows, total = cashflows.list_cashflows(seeded_db, pool_ids=[1])
    assert total >= 1 and all(r["pool_id"] == 1 for r in rows)


def test_list_cashflows_user_only_filter(seeded_db):
    _make_flow(seeded_db, direction="OUT", nature="BUSINESS_OUT")
    rows, total = cashflows.list_cashflows(seeded_db, user=_restricted_user())
    assert rows == [] and total == 0


def test_list_cashflows_deposit_source(seeded_db):
    deposits.create_deposit(seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest")
    rows, _ = cashflows.list_cashflows(seeded_db)
    deposit_rows = [r for r in rows if r["source_type"] == CashflowSourceType.DEPOSIT.value]
    assert deposit_rows
    assert all(r["source"] == "DEPOSIT" for r in deposit_rows)


def test_return_deposit_rejects_unknown(seeded_db):
    with pytest.raises(NotFound, match="押金 999999 不存在"):
        deposits.return_deposit(
            seeded_db, 999999, amount=Decimal("5"), released_on=TODAY, actor="pytest"
        )


def test_return_deposit_rejects_exceeds(seeded_db):
    deposit = deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(Validation, match="退还金额超过未释放余额"):
        deposits.return_deposit(
            seeded_db, deposit.id, amount=Decimal("20"), released_on=TODAY, actor="pytest"
        )


def test_cancel_paid_deposit_writes_one_reversal(seeded_db):
    deposit = deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("300"), paid_on=TODAY, actor="pytest"
    )
    cancelled = deposits.cancel_deposit(
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
        deposits.cancel_deposit(
            seeded_db, 999999, cancelled_on=TODAY, reason="x", actor="pytest"
        )


def test_cancel_returned_deposit_rejected(seeded_db):
    deposit = deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("300"), paid_on=TODAY, actor="pytest"
    )
    deposits.return_deposit(
        seeded_db, deposit.id, amount=Decimal("100"), released_on=TODAY, actor="pytest"
    )
    with pytest.raises(Validation):
        deposits.cancel_deposit(
            seeded_db, deposit.id, cancelled_on=TODAY,
            reason="已有退还不可取消", actor="pytest",
        )


def test_create_deposit_rejects_negative_amount(seeded_db):
    with pytest.raises(Validation):
        deposits.create_deposit(
            seeded_db, pool_id=1, amount=Decimal("-100"), paid_on=TODAY, actor="pytest"
        )


def test_return_deposit_partial(seeded_db):
    deposit = deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    returned = deposits.return_deposit(
        seeded_db, deposit.id, amount=Decimal("4"), released_on=TODAY, actor="pytest"
    )
    assert returned.status == "PARTIALLY_RETURNED"


def test_lose_deposit_rejects_exceeds(seeded_db):
    deposit = deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(Validation, match="损失金额超过未释放余额"):
        deposits.lose_deposit(
            seeded_db, deposit.id, amount=Decimal("20"), lost_on=TODAY,
            category="OFFICE", reason="x", actor="pytest",
        )


def test_lose_deposit_marks_lost(seeded_db):
    deposit = deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    lost = deposits.lose_deposit(
        seeded_db, deposit.id, amount=Decimal("10"), lost_on=TODAY,
        category="OFFICE", reason="x", actor="pytest",
    )
    assert lost.source_type == CashflowSourceType.DEPOSIT.value
    assert lost.source_id == str(deposit.id)


def test_create_deposit_rejects_unknown_source_order(seeded_db):
    with pytest.raises(NotFound, match="来源订单 999999 不存在"):
        deposits.create_deposit(
            seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest",
            source_order_id=999999,
        )


def test_list_deposits_user_only_filter(seeded_db):
    deposits.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    assert deposits.list_deposits(seeded_db, user=_restricted_user()) == []


def test_list_cashflows_by_pool_id_visible(seeded_db):
    cashflows.create_cashflow(
        seeded_db, pool_id=1, occurred_on=TODAY,
        direction="IN", nature="EXTERNAL_IN", category="客户收款",
        amount=Decimal("50"), actor="pytest", note="列表可见性测试",
    )
    items, total = cashflows.list_cashflows(seeded_db, pool_id=1, user=_all_scope_user())
    assert total >= 1
    assert all(item["pool_id"] == 1 for item in items)


def _cashflow_row(**overrides):
    """列表路径的 row dict 形态（`_cashflow_out` 的 dict 分支入参）。"""
    from datetime import datetime

    row = dict(
        id=1, flow_no="ZC00001", pool_id=1, occurred_on=TODAY,
        occurred_at=datetime(2026, 10, 17, 9, 0), nature="BUSINESS_IN",
        ledger_type="BUSINESS", accounting_attribute="SELF_REVENUE",
        category="SALE", direction="IN", amount=Decimal("10"),
        reviewed_by=None, reviewed_at=None, source_type="MANUAL", source_id=None,
        order_id=None, order_no=None,
        note=None, form_extra=None, operator="pytest", created_by="pytest",
    )
    row.update(overrides)
    return row


def test_cashflow_out_marks_order_event_source(seeded_db):
    """挂了订单事件就必须标 ORDER_EVENT —— 前端据此决定能否跳订单详情。"""
    from app.finance import router_output

    assert router_output._cashflow_out(seeded_db, _cashflow_row(source_type="ORDER_EVENT", source_id="HS0001-EV-BUY-01")).source == (
        "ORDER_EVENT"
    )


def test_cashflow_out_marks_order_event_rebate_source(seeded_db):
    """返点收入流水通过返点订单事件回指来源。"""
    from app.finance import router_output

    out = router_output._cashflow_out(
        seeded_db,
        _cashflow_row(category="REBATE", source_type="ORDER_EVENT", source_id="HS0001-EV-REBATE-01"),
    )
    assert out.source == "ORDER_EVENT"
