"""DEPOSIT-01 finance 押金与返点契约测试（DEP-01 / REB-01）。

与 test_m2.py 的分工：既有文件已覆盖押金占用/部分退回、
超退校验、返点记录与到账主路径；本文件补押金退还 404、押金列表与持有合计、
来源订单不存在、结算 404 与手续费超额、返点列表过滤，以及 4 个未测路由端点。
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
from app.core.security import CurrentUser, build_access_token
from app.domain.foundation import Pool
from app.domain.trade import Cashflow, RebateRecord, Reconciliation
from app.finance.cashflows import create_cashflow, list_cashflows, reverse_cashflow
from app.finance.deposits import create_deposit, deposit_held_total, list_deposits, lose_deposit, return_deposit
from app.finance.rebates import create_rebate, list_rebates
from app.finance.reconciliation import create_reconciliation, resolve_reconciliation
from app.finance.transfers import create_transfer, repair_transfer
from app.orders.create import create_order
from app.orders.events import post_event
from app.finance.balances import pool_balance
from app.parties.counterparties import create_counterparty, set_counterparty_status
from app.reporting.funds import daily_funds_report
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

    def test_internal_cashflow_requires_transfer_id(self, seeded_db):
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
                status="APPROVED",
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
                status="APPROVED",
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
        assert flow.status == "APPROVED"
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
        assert reversal.reversal_of_id == flow.id
        assert reversal.status == "APPROVED"
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


class TestReconciliation:
    @pytest.mark.parametrize("raw_ids", [[[1]], [0], [True], ["1"]])
    def test_reconciliation_rejects_invalid_unmatched_flow_ids(
        self, seeded_db, raw_ids
    ):
        invest = _pool(seeded_db, "HJ_INVEST")

        with pytest.raises(Validation, match="正整数"):
            create_reconciliation(
                seeded_db,
                pool_id=invest.id,
                reconciled_on=TODAY,
                account_label="招商银行卡",
                statement_balance=Decimal("0.00"),
                unmatched_flow_ids=raw_ids,
                actor="finance",
            )

    def test_reconciliation_snapshots_difference_and_unmatched_flows(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        flow = Cashflow(
            flow_no="CF-RECON-1",
            pool_id=invest.id,
            occurred_on=TODAY,
            nature="BUSINESS_IN",
            category="OTHER",
            direction="IN",
            amount=Decimal("100.00"),
            status="APPROVED",
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(flow)
        seeded_db.flush()

        item = create_reconciliation(
            seeded_db,
            pool_id=invest.id,
            reconciled_on=TODAY,
            account_label="招商银行卡",
            statement_balance=Decimal("90.00"),
            unmatched_flow_ids=[flow.id],
            reason="银行手续费尚未入账",
            actor="finance",
        )

        assert item.system_balance == Decimal("100.00")
        assert item.difference == Decimal("-10.00")
        assert item.unmatched_flow_ids == [flow.id]
        assert item.status == "OPEN"

        resolved = resolve_reconciliation(
            seeded_db, item.id, actor="finance", reason="已完成银行核对"
        )
        assert resolved.status == "RESOLVED"
        assert resolved.resolved_by == "finance"

        with pytest.raises(Validation, match="已核销"):
            resolve_reconciliation(
                seeded_db, item.id, actor="finance", reason="重复核销"
            )

    def test_reconciliation_requires_reason_for_difference(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        with pytest.raises(Validation, match="差异原因"):
            create_reconciliation(
                seeded_db,
                pool_id=invest.id,
                reconciled_on=TODAY,
                account_label="银行卡",
                statement_balance=Decimal("1.00"),
                actor="finance",
            )


class TestFinanceApi:
    def test_reconciliation_endpoints_snapshot_and_resolve(
        self, seeded_client, seeded_db, headers
    ):
        invest = _pool(seeded_db, "HJ_INVEST")
        flow = Cashflow(
            flow_no="CF-RECON-API-1",
            pool_id=invest.id,
            occurred_on=TODAY,
            nature="BUSINESS_IN",
            category="OTHER",
            direction="IN",
            amount=Decimal("100.00"),
            status="APPROVED",
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(flow)
        seeded_db.flush()

        created = seeded_client.post(
            "/api/v1/reconciliations",
            json={
                "pool_id": 1,
                "reconciled_on": TODAY.isoformat(),
                "account_label": "招商银行卡",
                "statement_balance": "90.00",
                "unmatched_flow_ids": [flow.id],
                "reason": "手续费未入账",
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text
        item = created.json()
        assert item["system_balance"] == "100.00"
        assert item["difference"] == "-10.00"
        assert item["unmatched_flow_ids"] == [flow.id]
        assert item["operator"] == "admin"
        assert item["created_at"]

        listed = seeded_client.get(
            "/api/v1/reconciliations",
            params={"pool_id": invest.id},
            headers=headers,
        )
        assert listed.status_code == 200, listed.text
        assert listed.json()[0]["id"] == item["id"]

        resolved = seeded_client.post(
            f"/api/v1/reconciliations/{item['id']}/resolve",
            json={"reason": "已核实银行手续费"},
            headers=headers,
        )
        assert resolved.status_code == 200, resolved.text
        assert resolved.json()["status"] == "RESOLVED"

    def test_manual_cashflow_review_and_reverse_endpoints(
        self, seeded_client, seeded_db, headers
    ):
        created = seeded_client.post(
            "/api/v1/cashflows",
            json={
                "pool_id": 1,
                "occurred_on": TODAY.isoformat(),
                "direction": "OUT",
                "nature": "BUSINESS_OUT",
                "category": "OPERATING",
                "amount": "25.00",
                "note": "接口测试费用",
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text
        flow = created.json()
        assert flow["status"] == "APPROVED"

        reversed_flow = seeded_client.post(
            f"/api/v1/cashflows/{flow['id']}/reverse",
            json={"reversed_on": TODAY.isoformat(), "reason": "接口冲销"},
            headers=headers,
        )
        assert reversed_flow.status_code == 200, reversed_flow.text
        assert reversed_flow.json()["reversal_of_id"] == flow["id"]

    def test_order_cashflow_endpoint_links_income_without_creating_event(
        self, seeded_client, seeded_db, headers
    ):
        order_id = _active_order(seeded_db)
        created = seeded_client.post(
            f"/api/v1/orders/{order_id}/cashflows",
            json={
                "pool_id": 1,
                "occurred_on": TODAY.isoformat(),
                "direction": "IN",
                "nature": "BUSINESS_IN",
                "fund_nature": "BUSINESS",
                "accounting_attribute": "SELF_REVENUE",
                "category": "OTHER",
                "amount": "100.00",
                "note": "补登记收入",
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text
        flow = created.json()
        assert flow["order_id"] == order_id
        assert flow["direction"] == "IN"
        assert flow["category"] == "OTHER"
        assert seeded_db.scalar(
            select(Cashflow).where(Cashflow.id == flow["id"])
        ).order_event_id is None

    def test_pool_scoped_finance_user_cannot_transfer_or_read_other_pool(
        self, seeded_client, seeded_db
    ):
        scoped_finance = CurrentUser.build(
            id=3,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )
        scoped_headers = {"Authorization": f"Bearer {build_access_token(scoped_finance)}"}

        transfer = seeded_client.post(
            "/api/v1/transfers",
            json={
                "source_pool_id": 2,
                "target_pool_id": 1,
                "amount": "10.00",
                "occurred_on": TODAY.isoformat(),
            },
            headers=scoped_headers,
        )
        assert transfer.status_code == 404

        deposits = seeded_client.get(
            "/api/v1/deposits", params={"pool_id": 2}, headers=scoped_headers
        )
        assert deposits.status_code == 200
        assert deposits.json() == []

    def test_scoped_finance_filters_unqualified_deposits_and_rebates(
        self, seeded_client, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )

        scoped_headers = {"Authorization": f"Bearer {build_access_token(scoped)}"}

        create_deposit(
            seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
        )
        create_deposit(
            seeded_db, pool_id=2, amount=Decimal("20"), paid_on=TODAY, actor="pytest"
        )
        own_account = create_account(
            seeded_db,
            game_account="finance-own-account",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="scoped-finance",
        )
        own_order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="scoped-finance",
            owner_id=9,
            account_id=own_account.id,
        )
        other_account = create_account(
            seeded_db,
            game_account="finance-other-account",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="other",
        )
        other_order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="other",
            owner_id=8,
            account_id=other_account.id,
        )
        post_event(
            seeded_db, own_order.id, event_type="BUY", amount=Decimal("10"),
            occurred_on=TODAY, actor="pytest",
        )
        post_event(
            seeded_db, other_order.id, event_type="BUY", amount=Decimal("20"),
            occurred_on=TODAY, actor="pytest",
        )
        create_rebate(
            seeded_db, source_order_id=own_order.id, rebate_type="BUY", amount=Decimal("10"),
            collected_on=TODAY, actor="pytest"
        )
        create_rebate(
            seeded_db, source_order_id=other_order.id, rebate_type="BUY", amount=Decimal("20"),
            collected_on=TODAY, actor="pytest"
        )

        deposits = seeded_client.get("/api/v1/deposits", headers=scoped_headers)
        assert deposits.status_code == 200, deposits.text
        assert {row["pool_id"] for row in deposits.json()} == {1}

        rebates = seeded_client.get("/api/v1/rebates", headers=scoped_headers)
        assert rebates.status_code == 200, rebates.text
        assert [row["source_order_id"] for row in rebates.json()] == [own_order.id]

        create_other_pool = seeded_client.post(
            "/api/v1/deposits",
            json={"pool_id": 2, "amount": "5", "paid_on": TODAY.isoformat()},
            headers=scoped_headers,
        )
        assert create_other_pool.status_code == 404

    def test_scoped_finance_services_enforce_pool_visibility_without_router_filters(
        self, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )
        create_deposit(
            seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
        )
        create_deposit(
            seeded_db, pool_id=2, amount=Decimal("20"), paid_on=TODAY, actor="pytest"
        )

        deposits = list_deposits(seeded_db, user=scoped)
        cashflows, _ = list_cashflows(seeded_db, user=scoped)

        assert deposits
        assert {item.pool_id for item in deposits} == {1}
        assert cashflows
        assert {item["pool_id"] for item in cashflows} == {1}

    def test_scoped_cashflow_pagination_is_global_across_allowed_pools(
        self, seeded_client, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1, 2}),
        )
        scoped_headers = {"Authorization": f"Bearer {build_access_token(scoped)}"}
        seeded_db.add_all(
            [
                Cashflow(
                    flow_no="CF-PAGE-1", pool_id=1, occurred_on=date(2026, 10, 1),
                    nature="BUSINESS_IN", category="OTHER", direction="IN", amount=Decimal("1"),
                    created_by="pytest", updated_by="pytest",
                ),
                Cashflow(
                    flow_no="CF-PAGE-2", pool_id=2, occurred_on=date(2026, 10, 2),
                    nature="BUSINESS_IN", category="OTHER", direction="IN", amount=Decimal("2"),
                    created_by="pytest", updated_by="pytest",
                ),
                Cashflow(
                    flow_no="CF-PAGE-3", pool_id=1, occurred_on=date(2026, 10, 3),
                    nature="BUSINESS_IN", category="OTHER", direction="IN", amount=Decimal("3"),
                    created_by="pytest", updated_by="pytest",
                ),
            ]
        )
        seeded_db.flush()

        response = seeded_client.get(
            "/api/v1/cashflows",
            params={"limit": 2, "offset": 2},
            headers=scoped_headers,
        )
        assert response.status_code == 200, response.text
        assert [row["flow_no"] for row in response.json()["items"]] == ["CF-PAGE-1"]

    def test_cashflow_list_total_counts_all_matching_rows(
        self, seeded_client, seeded_db
    ):
        """分页响应中的 total 必须等于命中总数（而非本页条数），前端据此判断还有更多。"""
        scoped = CurrentUser.build(
            id=11,
            username="scoped-finance-total",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1, 2}),
        )
        scoped_headers = {"Authorization": f"Bearer {build_access_token(scoped)}"}
        seeded_db.add_all(
            [
                Cashflow(
                    flow_no="CF-TOTAL-1", pool_id=1, occurred_on=date(2026, 10, 1),
                    nature="BUSINESS_IN", category="OTHER", direction="IN", amount=Decimal("1"),
                    created_by="pytest", updated_by="pytest",
                ),
                Cashflow(
                    flow_no="CF-TOTAL-2", pool_id=2, occurred_on=date(2026, 10, 2),
                    nature="BUSINESS_IN", category="OTHER", direction="IN", amount=Decimal("2"),
                    created_by="pytest", updated_by="pytest",
                ),
                Cashflow(
                    flow_no="CF-TOTAL-3", pool_id=1, occurred_on=date(2026, 10, 3),
                    nature="BUSINESS_IN", category="OTHER", direction="IN", amount=Decimal("3"),
                    created_by="pytest", updated_by="pytest",
                ),
            ]
        )
        seeded_db.flush()

        # 翻完所有页，收集 flow_no，验证 total 一致且不被截断。
        collected: list[str] = []
        offset = 0
        page_total = None
        while True:
            page = seeded_client.get(
                "/api/v1/cashflows",
                params={"limit": 2, "offset": offset},
                headers=scoped_headers,
            )
            assert page.status_code == 200, page.text
            body = page.json()
            if page_total is None:
                page_total = body["total"]
            else:
                assert body["total"] == page_total
            collected.extend(row["flow_no"] for row in body["items"])
            if not body["items"] or len(collected) >= page_total:
                break
            offset += 2
        assert page_total is not None and page_total >= 3
        for expected in ("CF-TOTAL-1", "CF-TOTAL-2", "CF-TOTAL-3"):
            assert expected in collected

    def test_scoped_cashflow_order_filter_respects_order_owner(
        self, seeded_client, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )
        headers = {"Authorization": f"Bearer {build_access_token(scoped)}"}
        own_order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="scoped-finance",
            owner_id=9,
        )
        foreign_order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="other",
            owner_id=8,
        )
        seeded_db.add_all(
            [
                Cashflow(
                    flow_no="CF-SCOPE-OWN",
                    pool_id=1,
                    occurred_on=TODAY,
                    nature="BUSINESS_IN",
                    category="OTHER",
                    direction="IN",
                    amount=Decimal("10"),
                    order_id=own_order.id,
                    created_by="pytest",
                    updated_by="pytest",
                ),
                Cashflow(
                    flow_no="CF-SCOPE-OTHER",
                    pool_id=1,
                    occurred_on=TODAY,
                    nature="BUSINESS_IN",
                    category="OTHER",
                    direction="IN",
                    amount=Decimal("20"),
                    order_id=foreign_order.id,
                    created_by="pytest",
                    updated_by="pytest",
                ),
            ]
        )
        seeded_db.flush()

        own = seeded_client.get(
            "/api/v1/cashflows",
            params={"order_id": own_order.id},
            headers=headers,
        )
        foreign = seeded_client.get(
            "/api/v1/cashflows",
            params={"order_id": foreign_order.id},
            headers=headers,
        )

        assert own.status_code == 200, own.text
        assert [row["flow_no"] for row in own.json()["items"]] == ["CF-SCOPE-OWN"]
        assert foreign.status_code == 200, foreign.text
        assert foreign.json()["items"] == []

    def test_scoped_operator_cannot_write_rebate_for_other_order(
        self, seeded_client, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        headers = {"Authorization": f"Bearer {build_access_token(scoped)}"}
        other_order = create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="other", owner_id=8
        )

        response = seeded_client.post(
            "/api/v1/rebates",
            json={
                "source_order_id": other_order.id,
                "amount": "10",
                "collected_on": TODAY.isoformat(),
                "rebate_type": "BUY",
            },
            headers=headers,
        )
        assert response.status_code == 404

    def test_rebate_service_respects_order_scope_when_user_is_supplied(
        self, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        foreign_order = create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="other", owner_id=8
        )
        with pytest.raises(NotFound):
            create_rebate(
                seeded_db,
                source_order_id=foreign_order.id,
                amount=Decimal("10"),
                collected_on=TODAY,
                actor="operator",
                user=scoped,
            )

    def test_scoped_finance_cannot_attach_deposit_to_foreign_order(
        self, seeded_client, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )
        headers = {"Authorization": f"Bearer {build_access_token(scoped)}"}
        foreign_order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="other",
            owner_id=8,
        )

        response = seeded_client.post(
            "/api/v1/deposits",
            json={
                "pool_id": 1,
                "amount": "20",
                "paid_on": TODAY.isoformat(),
                "source_order_id": foreign_order.id,
            },
            headers=headers,
        )

        assert response.status_code == 404, response.text


    def test_create_transfer_posts_symmetric_internal_cashflows(
        self, seeded_client, seeded_db, headers
    ):
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")
        create_cashflow(
            seeded_db,
            pool_id=invest.id,
            occurred_on=TODAY,
            direction="IN",
            nature="BUSINESS_IN",
            fund_nature="BUSINESS",
            accounting_attribute="SELF_REVENUE",
            category="OTHER",
            amount="200.00",
            actor="pytest",
        )
        source_before = pool_balance(seeded_db, invest.id)
        target_before = pool_balance(seeded_db, profit.id)

        response = seeded_client.post(
            "/api/v1/transfers",
            json={
                "source_pool_id": invest.id,
                "target_pool_id": profit.id,
                "amount": "125.50",
                "occurred_on": TODAY.isoformat(),
                "note": "补充买号资金",
            },
            headers=headers,
        )

        assert response.status_code == 201, response.text
        payload = response.json()
        assert payload["amount"] == "125.50"
        assert payload["operator"] == "admin"
        assert payload["created_at"]
        assert len(payload["cashflows"]) == 2
        assert {row["nature"] for row in payload["cashflows"]} == {"INTERNAL"}
        assert {row["direction"] for row in payload["cashflows"]} == {"IN", "OUT"}
        assert len({row["transfer_id"] for row in payload["cashflows"]}) == 1
        source_balance = pool_balance(seeded_db, invest.id)
        target_balance = pool_balance(seeded_db, profit.id)
        assert source_balance["cash_balance"] == source_before["cash_balance"] - Decimal("125.50")
        assert target_balance["cash_balance"] == target_before["cash_balance"] + Decimal("125.50")
        assert source_balance["transfer_in"] == Decimal("0.00")
        assert source_balance["transfer_out"] == Decimal("125.50")
        assert target_balance["transfer_in"] == Decimal("125.50")
        assert target_balance["transfer_out"] == Decimal("0.00")
        assert source_balance["cash_balance"] + target_balance["cash_balance"] == (
            source_before["cash_balance"] + target_before["cash_balance"]
        )

        report = daily_funds_report(seeded_db, on=TODAY)
        by_code = {item["pool_code"]: item for item in report["items"]}
        # 内部划转并入收入/支出两方向：划出账户记支出、划入账户记收入，日报不再单列划转列。
        assert by_code["HJ_INVEST"]["expense"] >= Decimal("125.50")
        assert by_code["HJ_PROFIT"]["income"] >= Decimal("125.50")
        for key in ("transfer_in", "transfer_out"):
            assert key not in by_code["HJ_INVEST"], f"资金日报仍有独立方向列 {key}"
            assert key not in report["total"], f"资金日报合计仍有独立方向列 {key}"

    def test_transfer_service_respects_pool_scope(self, seeded_db):
        scoped_finance = CurrentUser.build(
            id=3,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )
        with pytest.raises(NotFound, match="资金池不存在"):
            create_transfer(
                seeded_db,
                source_pool_id=2,
                target_pool_id=1,
                amount=Decimal("10"),
                occurred_on=TODAY,
                actor="scoped-finance",
                user=scoped_finance,
            )

    def test_repair_unpaired_transfer_creates_only_missing_side(
        self, seeded_db
    ):
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")
        seeded_db.add(
            Cashflow(
                flow_no="TR-REPAIR-OUT",
                pool_id=invest.id,
                occurred_on=TODAY,
                nature="INTERNAL",
                category="TRANSFER",
                direction="OUT",
                amount=Decimal("80"),
                transfer_id="TR-REPAIR",
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.flush()

        result = repair_transfer(
            seeded_db,
            "TR-REPAIR",
            counterpart_pool_id=profit.id,
            actor="finance",
            reason="补齐历史单边划转",
        )

        assert len(result["cashflows"]) == 2
        rows = seeded_db.scalars(
            select(Cashflow).where(Cashflow.transfer_id == "TR-REPAIR")
        ).all()
        assert {row.pool_id for row in rows} == {invest.id, profit.id}
        assert {row.direction for row in rows} == {"IN", "OUT"}
        assert {row.amount for row in rows} == {Decimal("80.00")}

        with pytest.raises(Validation, match="已完整"):
            repair_transfer(
                seeded_db,
                "TR-REPAIR",
                counterpart_pool_id=profit.id,
                actor="finance",
                reason="重复修复",
            )

    def test_repair_transfer_endpoint(self, seeded_client, seeded_db, headers):
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")
        seeded_db.add(
            Cashflow(
                flow_no="TR-REPAIR-API-OUT",
                pool_id=invest.id,
                occurred_on=TODAY,
                nature="INTERNAL",
                category="TRANSFER",
                direction="OUT",
                amount=Decimal("45"),
                transfer_id="TR-REPAIR-API",
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.flush()

        response = seeded_client.post(
            "/api/v1/transfers/TR-REPAIR-API/repair",
            json={
                "counterpart_pool_id": profit.id,
                "reason": "补齐对端流水",
            },
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert len(response.json()["cashflows"]) == 2


    def test_list_deposits_endpoint(self, seeded_client, seeded_db, headers):
        invest = _pool(seeded_db, "HJ_INVEST")
        order_id = _active_order(seeded_db)
        create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("1000"), paid_on=TODAY,
            actor="pytest", source_order_id=order_id,
            expected_release_on=TODAY.replace(day=20), note="押金业务备注",
        )
        response = seeded_client.get("/api/v1/deposits", headers=headers)
        assert response.status_code == 200, response.text
        assert len(response.json()) == 1
        assert "deposit_no" not in response.json()[0]
        assert response.json()[0]["source_order_id"] == order_id
        assert response.json()[0]["expected_release_on"] == "2026-10-20"
        assert response.json()[0]["note"] == "押金业务备注"
        assert response.json()[0]["operator"] == "pytest"
        assert response.json()[0]["created_at"]

    def test_deposit_loss_endpoint_returns_operating_cashflow(
        self, seeded_client, seeded_db, headers
    ):
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
        )
        response = seeded_client.post(
            f"/api/v1/deposits/{deposit.id}/losses",
            json={
                "amount": "40",
                "lost_on": TODAY.isoformat(),
                "category": "OPERATING_COST",
                "reason": "对方违约扣除",
            },
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["category"] == "OPERATING_COST"
        assert response.json()["source"] == "DEPOSIT"

    def test_list_rebates_endpoint(self, seeded_client, seeded_db, headers):
        order_id = _active_order(seeded_db)
        create_rebate(
            seeded_db, source_order_id=order_id, rebate_type="BUY", amount=Decimal("100"),
            collected_on=TODAY, actor="pytest", channel="买号返点",
            note="回收买号返点",
        )
        response = seeded_client.get("/api/v1/rebates", headers=headers)
        assert response.status_code == 200, response.text
        assert len(response.json()) == 1
        assert response.json()[0]["rebate_no"].startswith("HS")
        assert "rebate_group_no" not in response.json()[0]
        assert response.json()[0]["channel"] == "买号返点"
        assert response.json()[0]["link_status"] == "LINKED"
        assert response.json()[0]["note"] == "回收买号返点"
        assert response.json()[0]["operator"] == "pytest"
        assert response.json()[0]["created_at"]

    def test_create_rebate_endpoint(self, seeded_client, seeded_db, headers):
        order_id = _active_order(seeded_db)
        response = seeded_client.post(
            "/api/v1/rebates",
            json={
                "source_order_id": order_id,
                "amount": "300",
                "collected_on": TODAY.isoformat(),
                "rebate_type": "BUY",
                "channel": "WECHAT",
            },
            headers=headers,
        )
        assert response.status_code == 201, response.text
        assert response.json()["source_order_id"] == order_id
        assert response.json()["rebate_type"] == "BUY"
        assert response.json()["channel"] == "WECHAT"


