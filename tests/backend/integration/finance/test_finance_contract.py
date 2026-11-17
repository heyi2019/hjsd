"""DEPOSIT-01 finance 顶层契约：返点校验与共享 helper。

按 class 拆分后的保留文件；其余 class 分别在 deposits /
rebates_guards / reconciliation / api 四个文件。
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.stocks.profile import create_account
from app.core.errors import NotFound, Validation
from app.shared.operation_operators import list_operation_operators
from app.core.security import CurrentUser, build_access_token
from app.domain.foundation import Pool
from app.domain.enums import CashflowSourceType
from app.domain.trade import Cashflow, RebateRecord, Reconciliation
from app.finance.cashflow_queries import list_cashflows
from app.finance.cashflows import create_cashflow, reverse_cashflow
from app.finance.deposits import create_deposit, deposit_held_total, list_deposits, lose_deposit, return_deposit
from app.finance.rebates import create_rebate, list_rebates
from app.finance.reconciliation import create_reconciliation, resolve_reconciliation
from app.finance.transfers import create_transfer, repair_transfer
from app.orders.create import create_order
from app.orders.events import post_event
from app.finance.balances import pool_balance
from app.customer_center.counterparties import create_counterparty, set_counterparty_status
from app.reporting.r2_monthly_pnl import r2_monthly_pnl

TODAY = date(2026, 10, 4)


def _pool(seeded_db, code: str) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == code))
    assert pool is not None
    return pool


def _active_order(seeded_db) -> int:
    account = create_account(
        seeded_db,
        game_account=f"finance-active-{uuid4().hex[:10]}",
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
        seeded_db, order.id, event_type="BUY", amount=Decimal("500"),
        occurred_on=TODAY, actor="pytest",
    )
    return order.id


class TestRebateValidation:
    def test_rebate_link_status_is_closed_at_database_boundary(self, seeded_db):
        seeded_db.add(
            RebateRecord(
                rebate_no="RB-INVALID-LINK-STATUS",
                source_order_id=_active_order(seeded_db),
                amount=Decimal("500"),
                status="OPEN",
                link_status="AUTO_MATCHED",
                collected_on=TODAY,
                created_by="pytest",
                updated_by="pytest",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()


