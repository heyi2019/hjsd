"""REVERSAL-01 现金流冲销契约测试。

覆盖 reverse_cashflow 的正向与拒绝分支：
- 已审核独立流水可冲销，生成反向流水（方向反转、性质反转、属性=REVERSAL）；
- 冲销必须填原因；
- 已冲销流水不可再冲销；
- 业务事件派生流水必须走业务事件冲销，不能用独立冲销入口。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from app.core.errors import Validation
from app.domain.enums import AccountingAttribute, Direction
from app.finance.cashflows import create_cashflow, reverse_cashflow
from app.orders import events
from app.orders import service as orders_service

TODAY = date(2026, 10, 17)


def _make_flow(session, *, direction,
               accounting_attribute="OPERATING_EXPENSE", category="OTHER", amount="10",
               note="memo", order_id=None, pool_id=1):
    return create_cashflow(
        session, pool_id=pool_id, occurred_on=TODAY, direction=direction,
        accounting_attribute=accounting_attribute,
        category=category, amount=Decimal(amount), actor="pytest", note=note, order_id=order_id,
    )


def test_reverse_out_flow_creates_in_reversal(seeded_db):
    flow = _make_flow(seeded_db, direction="OUT", amount="120")
    reversal = reverse_cashflow(
        seeded_db, flow.id, reversed_on=TODAY, actor="pytest", reason="录错冲销",
    )
    assert reversal.id != flow.id
    assert reversal.direction == Direction.IN.value
    assert reversal.accounting_attribute == AccountingAttribute.REVERSAL.value
    assert reversal.reversal_of_id == flow.id
    assert reversal.amount == Decimal("120.00")
    # 正向流水金额不变，冲销另起一笔（冲销不修改原流水）。
    assert flow.amount == Decimal("120.00")


def test_reverse_in_flow_creates_out_reversal(seeded_db):
    flow = _make_flow(seeded_db, direction="IN", amount="80")
    reversal = reverse_cashflow(
        seeded_db, flow.id, reversed_on=TODAY, actor="pytest", reason="退款冲销",
    )
    assert reversal.direction == Direction.OUT.value
    assert reversal.reversal_of_id == flow.id


def test_reverse_requires_reason(seeded_db):
    flow = _make_flow(seeded_db, direction="OUT", amount="10")
    with pytest.raises(Validation, match="冲销流水必须填写原因"):
        reverse_cashflow(seeded_db, flow.id, reversed_on=TODAY, actor="pytest", reason="   ")


def test_reverse_rejects_already_reversed(seeded_db):
    flow = _make_flow(seeded_db, direction="OUT", amount="10")
    reverse_cashflow(seeded_db, flow.id, reversed_on=TODAY, actor="pytest", reason="第一次")
    with pytest.raises(Validation, match="该流水已冲销"):
        reverse_cashflow(
            seeded_db, flow.id, reversed_on=TODAY, actor="pytest", reason="第二次",
        )


def test_reverse_rejects_business_event_flow(seeded_db):
    """业务事件派生流水必须走业务事件冲销，不能用独立冲销入口。"""
    order = orders_service.create_order(
        seeded_db, order_type="TH", trade_date=TODAY, actor="pytest",
    )
    _event, flow = events.post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=TODAY, actor="pytest",
    )
    assert flow.order_event_id is not None
    with pytest.raises(Validation, match="业务事件现金流必须通过业务事件冲销"):
        reverse_cashflow(
            seeded_db, flow.id, reversed_on=TODAY, actor="pytest", reason="x",
        )
