"""现金流与押金服务拆分后的直接契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser
from app.domain.foundation import Pool
from app.finance import cashflows
from app.finance import service as finance_service
from app.finance import transfers


TODAY = date(2026, 10, 17)


def test_cashflows_module_creates_approved_cashflow(seeded_db):
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
    assert flow.status == "APPROVED"
    assert flow.category == "客户收款"


def test_finance_facade_re_exports_cashflow_entries():
    assert finance_service.create_cashflow is cashflows.create_cashflow
    assert finance_service.create_deposit is cashflows.create_deposit


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


def _make_flow(seeded_db, *, direction, nature, fund_nature="BUSINESS",
               accounting_attribute="OPERATING_EXPENSE", category="OTHER", amount="10",
               note="memo", order_id=None):
    return cashflows.create_cashflow(
        seeded_db,
        pool_id=1,
        occurred_on=TODAY,
        direction=direction,
        nature=nature,
        fund_nature=fund_nature,
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


def test_create_cashflow_rejects_attr_mismatch(seeded_db):
    with pytest.raises(Validation):
        _make_flow(
            seeded_db,
            direction="OUT",
            nature="BUSINESS_OUT",
            fund_nature="EXTERNAL",
            accounting_attribute="OPERATING_EXPENSE",
        )


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
    with pytest.raises(NotFound, match="资金池不存在"):
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
    from app.orders import service as orders_service

    order = orders_service.create_order(
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

    deposit = cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    flow = seeded_db.scalar(select(Cashflow).where(Cashflow.deposit_id == deposit.id))
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
    with pytest.raises(NotFound, match="资金池不存在"):
        cashflows.create_deposit(
            seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest",
            user=_restricted_user(),
        )


def test_return_deposit_rejects_user_not_visible(seeded_db):
    deposit = cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(NotFound, match="押金 1 不存在"):
        cashflows.return_deposit(
            seeded_db, deposit.id, amount=Decimal("5"), released_on=TODAY, actor="pytest",
            user=_restricted_user(),
        )


def test_return_deposit_marks_lost(seeded_db):
    deposit = cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
    )
    cashflows.lose_deposit(
        seeded_db, deposit.id, amount=Decimal("30"), lost_on=TODAY,
        category="OFFICE", reason="x", actor="pytest",
    )
    returned = cashflows.return_deposit(
        seeded_db, deposit.id, amount=Decimal("70"), released_on=TODAY, actor="pytest"
    )
    assert returned.status == "LOST"


def test_lose_deposit_rejects_user_not_visible(seeded_db):
    deposit = cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(NotFound, match="押金 1 不存在"):
        cashflows.lose_deposit(
            seeded_db, deposit.id, amount=Decimal("5"), lost_on=TODAY,
            category="OFFICE", reason="x", actor="pytest", user=_restricted_user(),
        )


def test_lose_deposit_rejects_system_category(seeded_db):
    deposit = cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(Validation, match="押金损失费用分类不能使用系统分类"):
        cashflows.lose_deposit(
            seeded_db, deposit.id, amount=Decimal("5"), lost_on=TODAY,
            category="DEPOSIT_HOLD", reason="x", actor="pytest",
        )


# ----------------------------------------------------------- list


def test_list_deposits_user_filter(seeded_db):
    cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    assert cashflows.list_deposits(seeded_db, pool_id=1, user=_restricted_user()) == []


def test_list_cashflows_user_filter(seeded_db):
    _make_flow(seeded_db, direction="OUT", nature="BUSINESS_OUT")
    # 无权资金池一律返回空：明细为空、总数也为 0（返回值恒为 (rows, total) 二元组，
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

    rows, _ = cashflows.list_cashflows(seeded_db, status="APPROVED")
    assert any(r["id"] == flow.id for r in rows)

    rows, _ = cashflows.list_cashflows(seeded_db, fund_nature="BUSINESS")
    assert any(r["id"] == flow.id for r in rows)
    rows, _ = cashflows.list_cashflows(seeded_db, accounting_attribute="OPERATING_EXPENSE")
    assert any(r["id"] == flow.id for r in rows)
    rows, _ = cashflows.list_cashflows(seeded_db, created_by="pytest")
    assert any(r["id"] == flow.id for r in rows)


def test_list_cashflows_rejects_bad_status(seeded_db):
    with pytest.raises(Validation, match="status 必须为"):
        cashflows.list_cashflows(seeded_db, status="BADSTATUS")


def test_list_cashflows_transfer_source(seeded_db):
    transfers.create_transfer(
        seeded_db, source_pool_id=1, target_pool_id=seeded_db.scalar(select(Pool).where(Pool.code == "HJ_PROFIT")).id,
        amount=Decimal("10"), occurred_on=TODAY, actor="pytest",
    )
    rows, total = cashflows.list_cashflows(seeded_db)
    transfer_rows = [r for r in rows if r["transfer_id"] is not None]
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
    cashflows.create_deposit(seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest")
    rows, _ = cashflows.list_cashflows(seeded_db)
    deposit_rows = [r for r in rows if r["deposit_id"] is not None]
    assert deposit_rows
    assert all(r["source"] == "DEPOSIT" for r in deposit_rows)


def test_return_deposit_rejects_unknown(seeded_db):
    with pytest.raises(NotFound, match="押金 999999 不存在"):
        cashflows.return_deposit(
            seeded_db, 999999, amount=Decimal("5"), released_on=TODAY, actor="pytest"
        )


def test_return_deposit_rejects_exceeds(seeded_db):
    deposit = cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(Validation, match="退还金额超过未释放余额"):
        cashflows.return_deposit(
            seeded_db, deposit.id, amount=Decimal("20"), released_on=TODAY, actor="pytest"
        )


def test_return_deposit_partial(seeded_db):
    deposit = cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    returned = cashflows.return_deposit(
        seeded_db, deposit.id, amount=Decimal("4"), released_on=TODAY, actor="pytest"
    )
    assert returned.status == "PARTIALLY_RETURNED"


def test_lose_deposit_rejects_exceeds(seeded_db):
    deposit = cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    with pytest.raises(Validation, match="损失金额超过未释放余额"):
        cashflows.lose_deposit(
            seeded_db, deposit.id, amount=Decimal("20"), lost_on=TODAY,
            category="OFFICE", reason="x", actor="pytest",
        )


def test_lose_deposit_marks_lost(seeded_db):
    deposit = cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    lost = cashflows.lose_deposit(
        seeded_db, deposit.id, amount=Decimal("10"), lost_on=TODAY,
        category="OFFICE", reason="x", actor="pytest",
    )
    assert lost.deposit_id == deposit.id


def test_create_deposit_rejects_unknown_source_order(seeded_db):
    with pytest.raises(NotFound, match="来源订单 999999 不存在"):
        cashflows.create_deposit(
            seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest",
            source_order_id=999999,
        )


def test_list_deposits_pool_ids_filter(seeded_db):
    cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    rows = cashflows.list_deposits(seeded_db, pool_ids=[1])
    assert len(rows) >= 1


def test_list_deposits_user_only_filter(seeded_db):
    cashflows.create_deposit(
        seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
    )
    assert cashflows.list_deposits(seeded_db, user=_restricted_user()) == []


def test_list_cashflows_by_pool_id_visible(seeded_db):
    cashflows.create_cashflow(
        seeded_db, pool_id=1, occurred_on=TODAY,
        direction="IN", nature="EXTERNAL_IN", category="客户收款",
        amount=Decimal("50"), actor="pytest", note="列表可见性测试",
    )
    items, total = cashflows.list_cashflows(seeded_db, pool_id=1, user=_all_scope_user())
    assert total >= 1
    assert all(item["pool_id"] == 1 for item in items)
