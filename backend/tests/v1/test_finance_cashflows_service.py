"""现金流与押金服务拆分后的直接契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.finance import cashflows
from app.finance import service as finance_service


TODAY = date(2026, 10, 17)


def test_cashflows_module_creates_pending_cashflow(seeded_db):
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
    assert flow.status == "PENDING"
    assert flow.category == "客户收款"


def test_finance_facade_re_exports_cashflow_entries():
    assert finance_service.create_cashflow is cashflows.create_cashflow
    assert finance_service.approve_cashflow is cashflows.approve_cashflow
    assert finance_service.create_deposit is cashflows.create_deposit
