"""RECON-01 日对账与资金划转服务拆分后的直接契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.domain.foundation import Pool
from app.finance import reconciliation, transfers
from app.finance.cashflows import create_cashflow
from app.finance.reconciliation import create_reconciliation
from app.finance.transfers import create_transfer, repair_transfer


TODAY = date(2026, 10, 17)


def test_reconciliation_module_creates_snapshot(seeded_db):
    item = reconciliation.create_reconciliation(
        seeded_db,
        pool_id=1,
        reconciled_on=TODAY,
        account_label="测试账户",
        statement_balance=Decimal("0"),
        actor="pytest",
    )

    assert item.pool_id == 1
    assert item.difference == Decimal("0.00")
    assert item.status == "OPEN"


def test_transfer_module_creates_symmetric_cashflows(seeded_db):
    pools = list(seeded_db.scalars(select(Pool).order_by(Pool.id)).all())
    create_cashflow(
        seeded_db,
        pool_id=pools[0].id,
        occurred_on=TODAY,
        direction="IN",
        nature="BUSINESS_IN",
        accounting_attribute="SELF_REVENUE",
        category="OTHER",
        amount=Decimal("100"),
        actor="pytest",
    )
    result = transfers.create_transfer(
        seeded_db,
        source_pool_id=pools[0].id,
        target_pool_id=pools[1].id,
        amount=Decimal("25"),
        occurred_on=TODAY,
        actor="pytest",
    )

    assert result["amount"] == Decimal("25.00")
    assert {flow.direction for flow in result["cashflows"]} == {"IN", "OUT"}


def test_finance_facade_re_exports_control_entries():
    assert create_reconciliation is reconciliation.create_reconciliation
    assert create_transfer is transfers.create_transfer
    assert repair_transfer is transfers.repair_transfer
