"""DEPOSIT-01 押金查询契约：TestDepositQueries 拆出（15 tests）。"""

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


class TestDepositQueries:
    def test_deposit_returned_and_lost_amount_cannot_exceed_paid_amount(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("100"), paid_on=TODAY,
            actor="pytest",
        )
        deposit.returned_amount = Decimal("101")
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_internal_cashflow_requires_transfer_source(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        seeded_db.add(
            Cashflow(
                flow_no="CF-INTERNAL-WITHOUT-TRANSFER",
                pool_id=invest.id,
                occurred_on=TODAY,
                nature="INTERNAL",
                category="TRANSFER",
                direction="IN",
                amount=Decimal("1.00"),
                source_type=CashflowSourceType.MANUAL.value,
                created_by="pytest",
                updated_by="pytest",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_cashflow_direction_and_nature_must_match(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        seeded_db.add(
            Cashflow(
                flow_no="CF-INVALID-DIRECTION-NATURE",
                pool_id=invest.id,
                occurred_on=TODAY,
                nature="EXTERNAL_IN",
                category="INVALID",
                direction="OUT",
                amount=Decimal("1.00"),
                created_by="pytest",
                updated_by="pytest",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_reconciliation_difference_matches_two_balances_in_database(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        seeded_db.add(
            Reconciliation(
                pool_id=invest.id,
                reconciled_on=TODAY,
                account_label="invalid-difference",
                system_balance=Decimal("100"),
                statement_balance=Decimal("90"),
                difference=Decimal("0"),
                status="OPEN",
                unmatched_flow_ids=[],
                created_by="pytest",
                updated_by="pytest",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_deposit_source_order_must_exist(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")

        with pytest.raises(NotFound, match="来源订单"):
            create_deposit(
                seeded_db,
                pool_id=invest.id,
                amount=Decimal("100"),
                paid_on=TODAY,
                actor="pytest",
                source_order_id=999999,
            )

    def test_cashflow_list_filters_accounting_dimensions(self, seeded_client, seeded_db, headers):
        invest = _pool(seeded_db, "HJ_INVEST")
        first = create_cashflow(
            seeded_db,
            pool_id=invest.id,
            occurred_on=TODAY,
            direction="IN",
            nature="EXTERNAL_IN",
            category="CUSTOMER_RECEIPT",
            amount=Decimal("100"),
            note="第一笔",
            actor="pytest",
        )
        second = create_cashflow(
            seeded_db,
            pool_id=invest.id,
            occurred_on=TODAY,
            direction="OUT",
            nature="BUSINESS_OUT",
            category="OPERATING_COST",
            amount=Decimal("20"),
            note="第二笔",
            actor="pytest",
        )
        seeded_db.flush()

        response = seeded_client.get(
            "/api/v1/cashflows",
            params={"nature": "EXTERNAL_IN", "category": "CUSTOMER_RECEIPT"},
            headers=headers,
        )

        assert response.status_code == 200, response.text
        assert [item["id"] for item in response.json()["items"]] == [first.id]
        assert second.id not in [item["id"] for item in response.json()["items"]]

    def test_positive_amounts_are_business_errors_in_service(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        with pytest.raises(Validation, match="必须大于 0"):
            create_deposit(
                seeded_db,
                pool_id=invest.id,
                amount=Decimal("0"),
                paid_on=TODAY,
                actor="pytest",
            )

    def test_text_inputs_are_business_errors_in_service(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        with pytest.raises(Validation, match="category 必须为文本"):
            create_cashflow(
                seeded_db,
                pool_id=invest.id,
                occurred_on=TODAY,
                direction="IN",
                nature="BUSINESS_IN",
                category=123,
                amount=Decimal("1"),
                actor="finance",
            )

        deposit = create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("100"), paid_on=TODAY,
            actor="pytest",
        )
        with pytest.raises(Validation, match="押金损失必须填写原因"):
            lose_deposit(
                seeded_db,
                deposit.id,
                amount=Decimal("1"),
                lost_on=TODAY,
                category="OPERATING_COST",
                reason=123,
                actor="finance",
            )

        with pytest.raises(Validation, match="对账账户必须为文本"):
            create_reconciliation(
                seeded_db,
                pool_id=invest.id,
                reconciled_on=TODAY,
                account_label=123,
                statement_balance=Decimal("0"),
                actor="finance",
            )

    def test_deposit_counterparty_must_exist(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        with pytest.raises(NotFound, match="合作方"):
            create_deposit(
                seeded_db,
                pool_id=invest.id,
                amount=Decimal("100"),
                paid_on=TODAY,
                actor="pytest",
                counterparty_id=999999,
            )

    def test_deposit_rejects_disabled_counterparty(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        counterparty = create_counterparty(
            seeded_db,
            display_name="已停用押金合作方",
            type="PEER",
            actor="pytest",
        )
        set_counterparty_status(
            seeded_db, counterparty.id, False, actor="pytest"
        )

        with pytest.raises(Validation, match="已停用"):
            create_deposit(
                seeded_db,
                pool_id=invest.id,
                amount=Decimal("100"),
                paid_on=TODAY,
                actor="pytest",
                counterparty_id=counterparty.id,
            )

    def test_return_deposit_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            return_deposit(
                seeded_db, 999999, amount=Decimal("10"), released_on=TODAY, actor="pytest"
            )

    def test_list_deposits_filters_by_pool(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")
        create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("1000"), paid_on=TODAY,
            actor="pytest",
        )
        create_deposit(
            seeded_db, pool_id=profit.id, amount=Decimal("500"), paid_on=TODAY,
            actor="pytest",
        )
        by_pool = list_deposits(seeded_db, pool_id=profit.id)
        assert [item.pool_id for item in by_pool] == [profit.id]
        assert len(list_deposits(seeded_db)) == 2

    def test_deposit_held_total_by_pool_and_overall(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")
        first = create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("1000"), paid_on=TODAY,
            actor="pytest",
        )
        create_deposit(
            seeded_db, pool_id=profit.id, amount=Decimal("500"), paid_on=TODAY,
            actor="pytest",
        )
        assert deposit_held_total(seeded_db, pool_id=invest.id) == Decimal(
            "1000.00"
        )
        assert deposit_held_total(seeded_db) == Decimal("1500.00")

        return_deposit(
            seeded_db, first.id, amount=Decimal("400"), released_on=TODAY, actor="pytest"
        )
        # 持有合计按「已付 - 已退」计算，退还后即时下降
        assert deposit_held_total(seeded_db, pool_id=invest.id) == Decimal(
            "600.00"
        )

    def test_deposit_loss_becomes_operating_expense_without_double_holding(
        self, seeded_db
    ):
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = create_deposit(
            seeded_db,
            pool_id=invest.id,
            amount=Decimal("1000"),
            paid_on=TODAY,
            actor="pytest",
        )

        lost = lose_deposit(
            seeded_db,
            deposit.id,
            amount=Decimal("300"),
            lost_on=TODAY,
            category="OPERATING_COST",
            reason="对方违约扣除",
            actor="finance",
            operator_user_ids=[1],
        )
        seeded_db.refresh(deposit)
        assert lost.category == "OPERATING_COST"
        assert lost.direction == "OUT"
        assert deposit.lost_amount == Decimal("300.00")
        assert deposit.status == "PAID"
        assert deposit_held_total(seeded_db, pool_id=invest.id) == Decimal(
            "700.00"
        )

        lose_deposit(
            seeded_db,
            deposit.id,
            amount=Decimal("700"),
            lost_on=TODAY,
            category="OPERATING_COST",
            reason="剩余全部损失",
            actor="finance",
            operator_user_ids=[1],
        )
        seeded_db.refresh(deposit)
        assert deposit.status == "LOST"
        assert deposit_held_total(seeded_db, pool_id=invest.id) == Decimal("0.00")

        pnl = r2_monthly_pnl(seeded_db)
        assert pnl["items"][0]["operating_expense"] == Decimal("1000.00")

    def test_deposit_loss_cannot_exceed_unreleased_balance(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
        )
        with pytest.raises(Validation, match="未释放余额"):
            lose_deposit(
                seeded_db,
                deposit.id,
                amount=Decimal("101"),
                lost_on=TODAY,
                category="OPERATING_COST",
                reason="超额",
                actor="finance",
            )


