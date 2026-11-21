"""DEPOSIT-01 押金查询契约：TestDepositQueries 拆出（15 tests）。"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.business.inventory.profile import create_account
from app.core.errors import NotFound, Validation
from app.domain.foundation import Pool
from app.domain.enums import CashflowSourceType
from app.domain.trade import Cashflow, Reconciliation
from app.funds.cashflows import create_cashflow
from app.funds.deposits.writes import create_deposit
from app.funds.deposits.lifecycle import cancel_deposit, lose_deposit, return_deposit
from app.funds.deposits.reads import deposit_held_total, list_deposits
from app.funds.reconciliation import create_reconciliation
from app.business.orders.create import create_order
from app.business.events import post_event
from app.funds.balances import pool_balance
from app.customers.counterparties import create_counterparty, set_counterparty_status
from app.operations.r2_monthly_pnl import r2_monthly_pnl

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

    def test_transfer_cashflow_requires_source_id(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        seeded_db.add(
            Cashflow(
                flow_no="CF-TRANSFER-WITHOUT-SOURCE-ID",
                pool_id=invest.id,
                occurred_on=TODAY,
                category="TRANSFER",
                direction="IN",
                amount=Decimal("1.00"),
                source_type=CashflowSourceType.TRANSFER.value,
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
            category="OPERATING_COST",
            amount=Decimal("20"),
            note="第二笔",
            actor="pytest",
        )
        seeded_db.flush()

        response = seeded_client.get(
            "/api/cashflows",
            params={"category": "CUSTOMER_RECEIPT"},
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


class TestDepositLedgerType:
    """两类押金账簿：业务押金 BUSINESS / 工作室押金 STUDIO（2026-11-19）。"""

    @staticmethod
    def _flows(seeded_db, deposit_id: int, category: str) -> list[Cashflow]:
        return list(
            seeded_db.scalars(
                select(Cashflow).where(
                    Cashflow.source_type == CashflowSourceType.DEPOSIT.value,
                    Cashflow.source_id == str(deposit_id),
                    Cashflow.category == category,
                )
            ).all()
        )

    def test_business_deposit_defaults_to_business_ledger(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
        )
        assert deposit.ledger_type == "BUSINESS"
        holds = self._flows(seeded_db, deposit.id, "DEPOSIT_HOLD")
        assert len(holds) == 1 and holds[0].ledger_type == "BUSINESS"

    def test_studio_deposit_lands_in_studio_ledger(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("200"), paid_on=TODAY,
            actor="pytest", ledger_type="STUDIO",
        )
        assert deposit.ledger_type == "STUDIO"
        holds = self._flows(seeded_db, deposit.id, "DEPOSIT_HOLD")
        assert len(holds) == 1 and holds[0].ledger_type == "STUDIO"

    def test_studio_deposit_rejects_source_order(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        order_id = _active_order(seeded_db)
        with pytest.raises(Validation, match="不能挂来源订单"):
            create_deposit(
                seeded_db, pool_id=invest.id, amount=Decimal("100"), paid_on=TODAY,
                actor="pytest", ledger_type="STUDIO", source_order_id=order_id,
            )

    def test_invalid_ledger_type_rejected(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        with pytest.raises(Validation, match="押金账簿"):
            create_deposit(
                seeded_db, pool_id=invest.id, amount=Decimal("100"), paid_on=TODAY,
                actor="pytest", ledger_type="BOGUS",
            )

    def test_studio_deposit_release_and_loss_flows_inherit_ledger(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("300"), paid_on=TODAY,
            actor="pytest", ledger_type="STUDIO",
        )
        return_deposit(
            seeded_db, deposit.id, amount=Decimal("100"), released_on=TODAY, actor="pytest"
        )
        lose_deposit(
            seeded_db, deposit.id, amount=Decimal("50"), lost_on=TODAY,
            category="OPERATING_COST", reason="工作室押金损失", actor="pytest",
        )
        releases = self._flows(seeded_db, deposit.id, "DEPOSIT_RELEASE")
        losses = self._flows(seeded_db, deposit.id, "OPERATING_COST")
        assert len(releases) == 1 and releases[0].ledger_type == "STUDIO"
        assert len(losses) == 1 and losses[0].ledger_type == "STUDIO"

    def test_update_ledger_type_syncs_hold_flow(self, seeded_db):
        from app.funds.deposits.writes import update_deposit
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
        )
        update_deposit(
            seeded_db, deposit.id, pool_id=invest.id, amount=Decimal("100"),
            paid_on=TODAY, actor="pytest", ledger_type="STUDIO",
        )
        seeded_db.refresh(deposit)
        assert deposit.ledger_type == "STUDIO"
        holds = self._flows(seeded_db, deposit.id, "DEPOSIT_HOLD")
        assert len(holds) == 1 and holds[0].ledger_type == "STUDIO"

    # ---- 取消结清后的台账勾稽与重复入账防线（回归）----
    def test_cancel_syncs_held_to_zero_and_keeps_balance(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        before_balance = pool_balance(seeded_db, invest.id)["cash_balance"]
        before_held = deposit_held_total(seeded_db, pool_id=invest.id)
        deposit = create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("1000"), paid_on=TODAY, actor="pytest"
        )
        after_create = pool_balance(seeded_db, invest.id)["cash_balance"]
        cancel_deposit(
            seeded_db, deposit.id, cancelled_on=TODAY, reason="租约取消未实际占用", actor="pytest"
        )
        seeded_db.refresh(deposit)
        # 台账：取消后在押与未释放余额均归零，与反向流水勾稽。
        assert deposit.returned_amount == Decimal("1000.00")
        assert deposit_held_total(seeded_db, pool_id=invest.id) == before_held
        # 资金：反向流水冲平，余额回到创建前（占用 OUT + 取消 IN 相抵）。
        assert pool_balance(seeded_db, invest.id)["cash_balance"] == before_balance
        assert after_create == before_balance - Decimal("1000.00")

    def test_cancel_blocks_further_return(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("1000"), paid_on=TODAY, actor="pytest"
        )
        cancel_deposit(
            seeded_db, deposit.id, cancelled_on=TODAY, reason="审查防线", actor="pytest"
        )
        before_balance = pool_balance(seeded_db, invest.id)["cash_balance"]
        with pytest.raises(Validation, match="未结清"):
            return_deposit(
                seeded_db, deposit.id, amount=Decimal("1000"), released_on=TODAY, actor="pytest"
            )
        assert pool_balance(seeded_db, invest.id)["cash_balance"] == before_balance
        assert len(self._flows(seeded_db, deposit.id, "DEPOSIT_RELEASE")) == 0

    def test_cancel_blocks_further_loss(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("1000"), paid_on=TODAY, actor="pytest"
        )
        cancel_deposit(
            seeded_db, deposit.id, cancelled_on=TODAY, reason="审查防线", actor="pytest"
        )
        with pytest.raises(Validation, match="未结清"):
            lose_deposit(
                seeded_db, deposit.id, amount=Decimal("300"), lost_on=TODAY,
                category="OPERATING_COST", reason="审查防线", actor="pytest",
            )
        assert len(self._flows(seeded_db, deposit.id, "OPERATING_COST")) == 0

    def test_returned_and_lost_are_terminal_for_return(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
        )
        return_deposit(
            seeded_db, deposit.id, amount=Decimal("100"), released_on=TODAY, actor="pytest"
        )
        with pytest.raises(Validation, match="未结清"):
            return_deposit(
                seeded_db, deposit.id, amount=Decimal("1"), released_on=TODAY, actor="pytest"
            )
        with pytest.raises(Validation, match="未结清"):
            lose_deposit(
                seeded_db, deposit.id, amount=Decimal("1"), lost_on=TODAY,
                category="OPERATING_COST", reason="终态拒绝", actor="pytest",
            )


