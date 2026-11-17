"""DEPOSIT-01 返点与流水守卫契约：TestRebateGuards + TestCashflowLifecycle。"""

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


class TestRebateGuards:
    def test_rebate_type_is_required_and_closed(self, seeded_db):
        order_id = _active_order(seeded_db)

        with pytest.raises(Validation, match="返点类型必须为"):
            create_rebate(
                seeded_db,
                source_order_id=order_id,
                rebate_type="UNSPECIFIED",
                amount=Decimal("100"),
                collected_on=TODAY,
                actor="pytest",
            )

    def test_rebate_type_uses_created_source_order(self, seeded_db):
        order = create_order(
            seeded_db,
            order_type="DG",
            trade_date=TODAY,
            actor="pytest",
        )

        record = create_rebate(
            seeded_db,
            source_order_id=order.id,
            rebate_type="SELL",
            amount=Decimal("100"),
            collected_on=TODAY,
            actor="pytest",
        )
        assert record.rebate_type == "SELL"

    def test_sell_rebate_accepts_recovery_order(self, seeded_db):
        """2026-10-28 口径：卖号返点不再限 DG，回收单有 SELL 事件即可登记。"""
        order_id = _active_order(seeded_db)
        post_event(
            seeded_db,
            order_id,
            event_type="SELL",
            amount=Decimal("800"),
            occurred_on=TODAY,
            actor="pytest",
        )

        record = create_rebate(
            seeded_db,
            source_order_id=order_id,
            rebate_type="SELL",
            amount=Decimal("100"),
            collected_on=TODAY,
            actor="pytest",
        )
        assert record.rebate_type == "SELL"

    def test_source_order_notfound(self, seeded_db):
        with pytest.raises(Validation) as exc:
            create_rebate(
                seeded_db, source_order_id=999999, amount=Decimal("100"),
                collected_on=TODAY, actor="pytest",
            )
        assert "来源订单" in str(exc.value)


    def test_list_rebates_filters_by_source_order(self, seeded_db):
        first = _active_order(seeded_db)
        second = _active_order(seeded_db)
        create_rebate(
            seeded_db, source_order_id=first, rebate_type="BUY", amount=Decimal("100"),
            collected_on=TODAY, actor="pytest",
        )
        create_rebate(
            seeded_db, source_order_id=second, rebate_type="BUY", amount=Decimal("200"),
            collected_on=TODAY, actor="pytest",
        )
        by_order = list_rebates(seeded_db, source_order_id=second)
        assert [item.amount for item in by_order] == [Decimal("200.00")]
        assert len(list_rebates(seeded_db)) == 2


class TestCashflowLifecycle:
    def test_manual_cashflow_counts_into_balance_immediately(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        before = pool_balance(seeded_db, invest.id)

        flow = create_cashflow(
            seeded_db,
            pool_id=invest.id,
            occurred_on=TODAY,
            direction="OUT",
            nature="BUSINESS_OUT",
            category="OPERATING",
            amount=Decimal("120.00"),
            actor="pytest",
            note="平台运营费",
        )
        assert not hasattr(flow, "status")
        after = pool_balance(seeded_db, invest.id)
        assert after["expense"] == before["expense"] + Decimal("120.00")
        assert after["cash_balance"] == before["cash_balance"] - Decimal("120.00")

    def test_approved_manual_cashflow_can_be_reversed_once(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        flow = create_cashflow(
            seeded_db,
            pool_id=invest.id,
            occurred_on=TODAY,
            direction="OUT",
            nature="BUSINESS_OUT",
            category="OPERATING",
            amount=Decimal("60.00"),
            actor="pytest",
            note="可冲销费用",
        )
        reversal = reverse_cashflow(
            seeded_db, flow.id, reversed_on=TODAY, actor="finance", reason="重复付款"
        )
        assert reversal.source_type == CashflowSourceType.REVERSAL.value
        assert reversal.source_id == flow.flow_no
        assert not hasattr(reversal, "status")
        assert pool_balance(seeded_db, invest.id)["cash_balance"] == 0

        with pytest.raises(Validation, match="已冲销"):
            reverse_cashflow(
                seeded_db, flow.id, reversed_on=TODAY, actor="finance", reason="再次冲销"
            )

        monthly = r2_monthly_pnl(seeded_db)
        assert monthly["items"] == []

    def test_business_event_cashflow_must_be_reversed_by_event(self, seeded_db):
        order_id = _active_order(seeded_db)
        event = seeded_db.scalar(
            select(Cashflow).where(Cashflow.order_id == order_id, Cashflow.category == "BUY")
        )
        assert event is not None
        with pytest.raises(Validation, match="业务事件"):
            reverse_cashflow(
                seeded_db, event.id, reversed_on=TODAY, actor="finance", reason="错误冲销"
            )


