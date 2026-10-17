"""finance 押金与返点契约测试（DEP-01 / REB-01）。

与 test_m2.py / test_bughunt.py 的分工：既有文件已覆盖押金占用/部分退回、
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

from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser, build_access_token
from app.domain.foundation import Pool
from app.domain.trade import Cashflow, RebateRecord, RebateSettlement, Reconciliation
from app.finance import service
from app.orders import service as orders_service
from app.parties import service as parties_service
from app.reporting import service as reporting_service

TODAY = date(2026, 10, 4)


def _pool(seeded_db, code: str) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == code))
    assert pool is not None
    return pool


def _active_order(seeded_db) -> int:
    order = orders_service.create_order(
        seeded_db,
        order_type="HS",
        trade_date=TODAY,
        actor="pytest",
        account_profile={"game_account": f"finance-active-{uuid4().hex[:10]}"},
    )
    orders_service.post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("500"),
        occurred_on=TODAY, actor="pytest",
    )
    return order.id


class TestRebateValidation:
    def test_rebate_link_status_is_closed_at_database_boundary(self, seeded_db):
        seeded_db.add(
            RebateRecord(
                rebate_no="RB-INVALID-LINK-STATUS",
                rate=Decimal("10"),
                base_amount=Decimal("500"),
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
        deposit = service.create_deposit(
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
            service.create_deposit(
                seeded_db,
                pool_id=invest.id,
                amount=Decimal("100"),
                paid_on=TODAY,
                actor="pytest",
                source_order_id=999999,
            )

    def test_positive_amounts_are_business_errors_in_service(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        with pytest.raises(Validation, match="必须大于 0"):
            service.create_deposit(
                seeded_db,
                pool_id=invest.id,
                amount=Decimal("0"),
                paid_on=TODAY,
                actor="pytest",
            )

    def test_text_inputs_are_business_errors_in_service(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        with pytest.raises(Validation, match="category 必须为文本"):
            service.create_cashflow(
                seeded_db,
                pool_id=invest.id,
                occurred_on=TODAY,
                direction="IN",
                nature="BUSINESS_IN",
                category=123,
                amount=Decimal("1"),
                actor="finance",
            )

        deposit = service.create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("100"), paid_on=TODAY,
            actor="pytest",
        )
        with pytest.raises(Validation, match="押金损失必须填写原因"):
            service.lose_deposit(
                seeded_db,
                deposit.id,
                amount=Decimal("1"),
                lost_on=TODAY,
                category="OPERATING_COST",
                reason=123,
                actor="finance",
            )

        with pytest.raises(Validation, match="对账账户必须为文本"):
            service.create_reconciliation(
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
            service.create_deposit(
                seeded_db,
                pool_id=invest.id,
                amount=Decimal("100"),
                paid_on=TODAY,
                actor="pytest",
                counterparty_id=999999,
            )

    def test_deposit_rejects_disabled_counterparty(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        counterparty = parties_service.create_counterparty(
            seeded_db,
            display_name="已停用押金合作方",
            type="PEER",
            actor="pytest",
        )
        parties_service.set_counterparty_status(
            seeded_db, counterparty.id, False, actor="pytest"
        )

        with pytest.raises(Validation, match="已停用"):
            service.create_deposit(
                seeded_db,
                pool_id=invest.id,
                amount=Decimal("100"),
                paid_on=TODAY,
                actor="pytest",
                counterparty_id=counterparty.id,
            )

    def test_return_deposit_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            service.return_deposit(
                seeded_db, 999999, amount=Decimal("10"), released_on=TODAY, actor="pytest"
            )

    def test_list_deposits_filters_by_pool(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")
        service.create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("1000"), paid_on=TODAY,
            actor="pytest",
        )
        service.create_deposit(
            seeded_db, pool_id=profit.id, amount=Decimal("500"), paid_on=TODAY,
            actor="pytest",
        )
        by_pool = service.list_deposits(seeded_db, pool_id=profit.id)
        assert [item.pool_id for item in by_pool] == [profit.id]
        assert len(service.list_deposits(seeded_db)) == 2

    def test_deposit_held_total_by_pool_and_overall(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")
        first = service.create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("1000"), paid_on=TODAY,
            actor="pytest",
        )
        service.create_deposit(
            seeded_db, pool_id=profit.id, amount=Decimal("500"), paid_on=TODAY,
            actor="pytest",
        )
        assert service.deposit_held_total(seeded_db, pool_id=invest.id) == Decimal(
            "1000.00"
        )
        assert service.deposit_held_total(seeded_db) == Decimal("1500.00")

        service.return_deposit(
            seeded_db, first.id, amount=Decimal("400"), released_on=TODAY, actor="pytest"
        )
        # 持有合计按「已付 - 已退」计算，退还后即时下降
        assert service.deposit_held_total(seeded_db, pool_id=invest.id) == Decimal(
            "600.00"
        )

    def test_deposit_loss_becomes_operating_expense_without_double_holding(
        self, seeded_db
    ):
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = service.create_deposit(
            seeded_db,
            pool_id=invest.id,
            amount=Decimal("1000"),
            paid_on=TODAY,
            actor="pytest",
        )

        lost = service.lose_deposit(
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
        assert service.deposit_held_total(seeded_db, pool_id=invest.id) == Decimal(
            "700.00"
        )

        service.lose_deposit(
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
        assert service.deposit_held_total(seeded_db, pool_id=invest.id) == Decimal("0.00")

        pnl = reporting_service.r2_monthly_pnl(seeded_db)
        assert pnl["items"][0]["operating_expense"] == Decimal("1000.00")

    def test_deposit_loss_cannot_exceed_unreleased_balance(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        deposit = service.create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("100"), paid_on=TODAY, actor="pytest"
        )
        with pytest.raises(Validation, match="未释放余额"):
            service.lose_deposit(
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
            service.create_rebate(
                seeded_db,
                source_order_id=order_id,
                rebate_type="UNSPECIFIED",
                base_amount=Decimal("100"),
                collected_on=TODAY,
                actor="pytest",
            )

    def test_rebate_type_must_match_source_order_event(self, seeded_db):
        order = orders_service.create_order(
            seeded_db,
            order_type="DG",
            trade_date=TODAY,
            actor="pytest",
        )

        with pytest.raises(Validation, match="卖号返点必须关联已过账的 SELL"):
            service.create_rebate(
                seeded_db,
                source_order_id=order.id,
                rebate_type="SELL",
                base_amount=Decimal("100"),
                collected_on=TODAY,
                actor="pytest",
            )

    def test_sell_rebate_only_accepts_distribution_order(self, seeded_db):
        order_id = _active_order(seeded_db)
        orders_service.post_event(
            seeded_db,
            order_id,
            event_type="SELL",
            amount=Decimal("800"),
            occurred_on=TODAY,
            actor="pytest",
        )

        with pytest.raises(Validation, match="卖号返点只能关联分销（DG）订单"):
            service.create_rebate(
                seeded_db,
                source_order_id=order_id,
                rebate_type="SELL",
                base_amount=Decimal("100"),
                collected_on=TODAY,
                actor="pytest",
            )

    def test_rebate_reversal_must_reference_existing_settlement(self, seeded_db):
        order_id = _active_order(seeded_db)
        record = service.create_rebate(
            seeded_db,
            source_order_id=order_id,
            rebate_type="BUY",
            base_amount=Decimal("100"),
            collected_on=TODAY,
            actor="pytest",
        )
        seeded_db.add(
            RebateSettlement(
                settlement_no="REB-INVALID-REVERSAL",
                rebate_record_id=record.id,
                settled_on=TODAY,
                gross_amount=Decimal("0"),
                platform_fee=Decimal("0"),
                net_amount=Decimal("0"),
                reversal_of_id=999999,
                created_by="pytest",
                updated_by="pytest",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_rebate_rate_cannot_exceed_one_hundred_in_database(self, seeded_db):
        order_id = _active_order(seeded_db)
        record = service.create_rebate(
            seeded_db,
            source_order_id=order_id,
            rebate_type="BUY",
            base_amount=Decimal("100"),
            collected_on=TODAY,
            actor="pytest",
        )
        record.rate = Decimal("101")
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_rebate_settlement_net_amount_matches_gross_less_fee(self, seeded_db):
        order_id = _active_order(seeded_db)
        record = service.create_rebate(
            seeded_db,
            source_order_id=order_id,
            rebate_type="BUY",
            base_amount=Decimal("100"),
            collected_on=TODAY,
            actor="pytest",
        )
        seeded_db.add(
            RebateSettlement(
                settlement_no="REB-INVALID-NET",
                rebate_record_id=record.id,
                settled_on=TODAY,
                gross_amount=Decimal("100"),
                platform_fee=Decimal("10"),
                net_amount=Decimal("95"),
                created_by="pytest",
                updated_by="pytest",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_rebate_rate_must_be_percentage_and_fee_non_negative(self, seeded_db):
        order_id = _active_order(seeded_db)

        with pytest.raises(Validation, match="返点比例"):
            service.create_rebate(
                seeded_db,
                source_order_id=order_id,
                rebate_type="BUY",
                base_amount=Decimal("100"),
                collected_on=TODAY,
                actor="pytest",
                rate=Decimal("100.01"),
            )

        record = service.create_rebate(
            seeded_db,
            source_order_id=order_id,
            rebate_type="BUY",
            base_amount=Decimal("100"),
            collected_on=TODAY,
            actor="pytest",
        )
        with pytest.raises(Validation, match="不能为负数"):
            service.settle_rebate(
                seeded_db,
                record.id,
                gross_amount=Decimal("10"),
                settled_on=TODAY,
                pool_id=_pool(seeded_db, "HJ_INVEST").id,
                actor="pytest",
                platform_fee=Decimal("-1"),
            )

    def test_rebate_is_settled_by_gross_amount_not_net_amount(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        order_id = _active_order(seeded_db)
        record = service.create_rebate(
            seeded_db,
            source_order_id=order_id,
            rebate_type="BUY",
            base_amount=Decimal("100"),
            collected_on=TODAY,
            actor="pytest",
        )

        settlement = service.settle_rebate(
            seeded_db,
            record.id,
            gross_amount=Decimal("100"),
            settled_on=TODAY,
            pool_id=invest.id,
            actor="finance",
            platform_fee=Decimal("10"),
        )

        seeded_db.refresh(record)
        assert settlement.net_amount == Decimal("90.00")
        assert record.status == "SETTLED"
        assert record.updated_by == "finance"

    def test_source_order_notfound(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.create_rebate(
                seeded_db, source_order_id=999999, base_amount=Decimal("100"),
                collected_on=TODAY, actor="pytest",
            )
        assert "来源订单" in str(exc.value)

    def test_settle_notfound(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        with pytest.raises(NotFound):
            service.settle_rebate(
                seeded_db, 999999, gross_amount=Decimal("100"), settled_on=TODAY,
                pool_id=invest.id, actor="pytest",
            )

    def test_fee_cannot_exceed_gross(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        order_id = _active_order(seeded_db)
        record = service.create_rebate(
            seeded_db, source_order_id=order_id, rebate_type="BUY", base_amount=Decimal("200"),
            collected_on=TODAY, actor="pytest", rate=Decimal("10"),
        )
        with pytest.raises(Validation) as exc:
            service.settle_rebate(
                seeded_db, record.id, gross_amount=Decimal("100"), settled_on=TODAY,
                pool_id=invest.id, actor="pytest", platform_fee=Decimal("150"),
            )
        assert "手续费不得大于到账金额" in str(exc.value)

    def test_list_rebates_filters_by_source_order(self, seeded_db):
        first = _active_order(seeded_db)
        second = _active_order(seeded_db)
        service.create_rebate(
            seeded_db, source_order_id=first, rebate_type="BUY", base_amount=Decimal("100"),
            collected_on=TODAY, actor="pytest",
        )
        service.create_rebate(
            seeded_db, source_order_id=second, rebate_type="BUY", base_amount=Decimal("200"),
            collected_on=TODAY, actor="pytest",
        )
        by_order = service.list_rebates(seeded_db, source_order_id=second)
        assert [item.base_amount for item in by_order] == [Decimal("200.00")]
        assert len(service.list_rebates(seeded_db)) == 2

    def test_rebate_settlement_reversal_keeps_original_and_reopens_receivable(
        self, seeded_db
    ):
        invest = _pool(seeded_db, "HJ_INVEST")
        order_id = _active_order(seeded_db)
        record = service.create_rebate(
            seeded_db,
            source_order_id=order_id,
            rebate_type="BUY",
            base_amount=Decimal("100"),
            collected_on=TODAY,
            actor="pytest",
        )
        original = service.settle_rebate(
            seeded_db,
            record.id,
            gross_amount=Decimal("100"),
            settled_on=TODAY,
            pool_id=invest.id,
            actor="pytest",
            platform_fee=Decimal("10"),
        )

        reversal = service.reverse_rebate_settlement(
            seeded_db,
            record.id,
            original.id,
            reversed_on=TODAY,
            actor="finance",
            reason="手续费录入错误",
        )

        seeded_db.refresh(record)
        assert reversal.reversal_of_id == original.id
        assert original.gross_amount == Decimal("100.00")
        assert record.status == "OPEN"
        assert record.updated_by == "finance"
        assert service.settled_net_total(seeded_db, record.id) == Decimal("0.00")
        assert seeded_db.scalar(
            select(Cashflow).where(Cashflow.id == reversal.cashflow_id)
        ).direction == "OUT"
        assert len(
            seeded_db.scalars(
                select(RebateSettlement).where(
                    RebateSettlement.rebate_record_id == record.id
                )
            ).all()
        ) == 2

        corrected = service.settle_rebate(
            seeded_db,
            record.id,
            gross_amount=Decimal("100"),
            settled_on=TODAY,
            pool_id=invest.id,
            actor="pytest",
            platform_fee=Decimal("5"),
        )
        seeded_db.refresh(record)
        assert corrected.net_amount == Decimal("95.00")
        assert record.status == "SETTLED"
        assert service.settled_net_total(seeded_db, record.id) == Decimal("95.00")

        with pytest.raises(Validation, match="已冲销"):
            service.reverse_rebate_settlement(
                seeded_db,
                record.id,
                original.id,
                reversed_on=TODAY,
                actor="finance",
                reason="重复冲销",
            )

    def test_rebate_reversal_is_signed_in_reports(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        order_id = _active_order(seeded_db)
        record = service.create_rebate(
            seeded_db,
            source_order_id=order_id,
            rebate_type="BUY",
            base_amount=Decimal("100"),
            collected_on=TODAY,
            actor="pytest",
            rate=Decimal("100"),
        )
        original = service.settle_rebate(
            seeded_db,
            record.id,
            gross_amount=Decimal("100"),
            settled_on=TODAY,
            pool_id=invest.id,
            actor="pytest",
            platform_fee=Decimal("10"),
        )
        service.reverse_rebate_settlement(
            seeded_db,
            record.id,
            original.id,
            reversed_on=TODAY,
            actor="finance",
            reason="更正手续费",
        )
        service.settle_rebate(
            seeded_db,
            record.id,
            gross_amount=Decimal("100"),
            settled_on=TODAY,
            pool_id=invest.id,
            actor="pytest",
            platform_fee=Decimal("5"),
        )

        r5 = reporting_service.r5_business_pnl(seeded_db)
        hs = next(item for item in r5["items"] if item["order_type"] == "HS")
        assert hs["settled_rebate"] == Decimal("95.00")
        assert hs["uncollected_rebate"] == Decimal("0.00")

        detail = reporting_service.order_profit_detail(seeded_db)
        assert detail["items"][0]["rebate"] == Decimal("95.00")


class TestCashflowLifecycle:
    def test_manual_cashflow_is_pending_until_approved(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        before = orders_service.pool_balance(seeded_db, invest.id)

        flow = service.create_cashflow(
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
        assert flow.status == "PENDING"
        assert orders_service.pool_balance(seeded_db, invest.id) == before

        service.approve_cashflow(seeded_db, flow.id, actor="finance")
        after = orders_service.pool_balance(seeded_db, invest.id)
        assert after["expense"] == before["expense"] + Decimal("120.00")
        assert after["cash_balance"] == before["cash_balance"] - Decimal("120.00")

    def test_rejected_cashflow_does_not_change_balance(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        flow = service.create_cashflow(
            seeded_db,
            pool_id=invest.id,
            occurred_on=TODAY,
            direction="IN",
            nature="EXTERNAL_IN",
            category="OTHER",
            amount=Decimal("80.00"),
            actor="pytest",
            note="待核实收款",
        )
        service.reject_cashflow(seeded_db, flow.id, actor="finance", reason="凭证不足")
        seeded_db.refresh(flow)
        assert flow.status == "REJECTED"
        assert orders_service.pool_balance(seeded_db, invest.id)["cash_balance"] == 0

    def test_approved_manual_cashflow_can_be_reversed_once(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        flow = service.create_cashflow(
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
        service.approve_cashflow(seeded_db, flow.id, actor="finance")
        reversal = service.reverse_cashflow(
            seeded_db, flow.id, reversed_on=TODAY, actor="finance", reason="重复付款"
        )
        assert reversal.reversal_of_id == flow.id
        assert reversal.status == "APPROVED"
        assert orders_service.pool_balance(seeded_db, invest.id)["cash_balance"] == 0

        with pytest.raises(Validation, match="已冲销"):
            service.reverse_cashflow(
                seeded_db, flow.id, reversed_on=TODAY, actor="finance", reason="再次冲销"
            )

        monthly = reporting_service.r2_monthly_pnl(seeded_db)
        assert monthly["items"] == []

    def test_business_event_cashflow_must_be_reversed_by_event(self, seeded_db):
        order_id = _active_order(seeded_db)
        event = seeded_db.scalar(
            select(Cashflow).where(Cashflow.order_id == order_id, Cashflow.category == "BUY")
        )
        assert event is not None
        with pytest.raises(Validation, match="业务事件"):
            service.reverse_cashflow(
                seeded_db, event.id, reversed_on=TODAY, actor="finance", reason="错误冲销"
            )


class TestReconciliation:
    @pytest.mark.parametrize("raw_ids", [[[1]], [0], [True], ["1"]])
    def test_reconciliation_rejects_invalid_unmatched_flow_ids(
        self, seeded_db, raw_ids
    ):
        invest = _pool(seeded_db, "HJ_INVEST")

        with pytest.raises(Validation, match="正整数"):
            service.create_reconciliation(
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

        item = service.create_reconciliation(
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

        resolved = service.resolve_reconciliation(
            seeded_db, item.id, actor="finance", reason="已完成银行核对"
        )
        assert resolved.status == "RESOLVED"
        assert resolved.resolved_by == "finance"

        with pytest.raises(Validation, match="已核销"):
            service.resolve_reconciliation(
                seeded_db, item.id, actor="finance", reason="重复核销"
            )

    def test_reconciliation_requires_reason_for_difference(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        with pytest.raises(Validation, match="差异原因"):
            service.create_reconciliation(
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
                "pool_id": invest.id,
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
        invest = _pool(seeded_db, "HJ_INVEST")
        created = seeded_client.post(
            "/api/v1/cashflows",
            json={
                "pool_id": invest.id,
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
        assert flow["status"] == "PENDING"

        approved = seeded_client.post(
            f"/api/v1/cashflows/{flow['id']}/approve", headers=headers
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["status"] == "APPROVED"

        reversed_flow = seeded_client.post(
            f"/api/v1/cashflows/{flow['id']}/reverse",
            json={"reversed_on": TODAY.isoformat(), "reason": "接口冲销"},
            headers=headers,
        )
        assert reversed_flow.status_code == 200, reversed_flow.text
        assert reversed_flow.json()["reversal_of_id"] == flow["id"]

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

        service.create_deposit(
            seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
        )
        service.create_deposit(
            seeded_db, pool_id=2, amount=Decimal("20"), paid_on=TODAY, actor="pytest"
        )
        own_order = orders_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="scoped-finance",
            owner_id=9,
            account_profile={"game_account": "finance-own-account"},
        )
        other_order = orders_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="other",
            owner_id=8,
            account_profile={"game_account": "finance-other-account"},
        )
        orders_service.post_event(
            seeded_db, own_order.id, event_type="BUY", amount=Decimal("10"),
            occurred_on=TODAY, actor="pytest",
        )
        orders_service.post_event(
            seeded_db, other_order.id, event_type="BUY", amount=Decimal("20"),
            occurred_on=TODAY, actor="pytest",
        )
        service.create_rebate(
            seeded_db, source_order_id=own_order.id, rebate_type="BUY", base_amount=Decimal("10"),
            collected_on=TODAY, actor="pytest"
        )
        service.create_rebate(
            seeded_db, source_order_id=other_order.id, rebate_type="BUY", base_amount=Decimal("20"),
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
        service.create_deposit(
            seeded_db, pool_id=1, amount=Decimal("10"), paid_on=TODAY, actor="pytest"
        )
        service.create_deposit(
            seeded_db, pool_id=2, amount=Decimal("20"), paid_on=TODAY, actor="pytest"
        )

        deposits = service.list_deposits(seeded_db, user=scoped)
        cashflows = service.list_cashflows(seeded_db, user=scoped)

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
        assert [row["flow_no"] for row in response.json()] == ["CF-PAGE-1"]

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
        own_order = orders_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="scoped-finance",
            owner_id=9,
        )
        foreign_order = orders_service.create_order(
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
        assert [row["flow_no"] for row in own.json()] == ["CF-SCOPE-OWN"]
        assert foreign.status_code == 200, foreign.text
        assert foreign.json() == []

    def test_scoped_operator_cannot_write_rebate_for_other_order(
        self, seeded_client, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        headers = {"Authorization": f"Bearer {build_access_token(scoped)}"}
        other_order = orders_service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="other", owner_id=8
        )

        response = seeded_client.post(
            "/api/v1/rebates",
            json={
                "source_order_id": other_order.id,
                "base_amount": "10",
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
        foreign_order = orders_service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="other", owner_id=8
        )
        with pytest.raises(NotFound):
            service.create_rebate(
                seeded_db,
                source_order_id=foreign_order.id,
                base_amount=Decimal("10"),
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
        foreign_order = orders_service.create_order(
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

    def test_scoped_finance_cannot_settle_rebate_into_foreign_pool(
        self, seeded_client, seeded_db
    ):
        scoped = CurrentUser.build(
            id=9,
            username="scoped-finance",
            roles=["OPERATOR"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )
        headers = {"Authorization": f"Bearer {build_access_token(scoped)}"}
        order = orders_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="scoped-finance",
            owner_id=9,
            account_profile={"game_account": "finance-settlement-account"},
        )
        orders_service.post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
            occurred_on=TODAY, actor="scoped-finance",
        )
        record = service.create_rebate(
            seeded_db,
            source_order_id=order.id,
            rebate_type="BUY",
            base_amount=Decimal("100"),
            collected_on=TODAY,
            actor="scoped-finance",
        )
        response = seeded_client.post(
            f"/api/v1/rebates/{record.id}/settlements",
            json={
                "gross_amount": "50",
                "settled_on": TODAY.isoformat(),
                "pool_id": 2,
            },
            headers=headers,
        )
        assert response.status_code == 404, response.text

    def test_create_transfer_posts_symmetric_internal_cashflows(
        self, seeded_client, seeded_db, headers
    ):
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")

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
        source_balance = orders_service.pool_balance(seeded_db, invest.id)
        target_balance = orders_service.pool_balance(seeded_db, profit.id)
        assert source_balance["cash_balance"] == Decimal("-125.50")
        assert target_balance["cash_balance"] == Decimal("125.50")
        assert source_balance["transfer_in"] == Decimal("0.00")
        assert source_balance["transfer_out"] == Decimal("125.50")
        assert target_balance["transfer_in"] == Decimal("125.50")
        assert target_balance["transfer_out"] == Decimal("0.00")
        assert source_balance["cash_balance"] + target_balance["cash_balance"] == Decimal("0.00")

        report = reporting_service.daily_funds_report(seeded_db, on=TODAY)
        by_code = {item["pool_code"]: item for item in report["items"]}
        assert by_code["HJ_INVEST"]["transfer_in"] == Decimal("0.00")
        assert by_code["HJ_INVEST"]["transfer_out"] == Decimal("125.50")
        assert by_code["HJ_PROFIT"]["transfer_in"] == Decimal("125.50")
        assert by_code["HJ_PROFIT"]["transfer_out"] == Decimal("0.00")
        assert report["total"]["transfer_in"] == Decimal("125.50")
        assert report["total"]["transfer_out"] == Decimal("125.50")

    def test_transfer_service_respects_pool_scope(self, seeded_db):
        scoped_finance = CurrentUser.build(
            id=3,
            username="scoped-finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )
        with pytest.raises(NotFound, match="资金池不存在"):
            service.create_transfer(
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

        result = service.repair_transfer(
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
            service.repair_transfer(
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

    def test_list_cashflows_exposes_order_traceability(self, seeded_client, seeded_db, headers):
        invest = _pool(seeded_db, "HJ_INVEST")
        order_id = _active_order(seeded_db)
        record = service.create_rebate(
            seeded_db, source_order_id=order_id, rebate_type="BUY", base_amount=Decimal("200"),
            collected_on=TODAY, actor="pytest",
        )
        service.settle_rebate(
            seeded_db, record.id, gross_amount=Decimal("120"), settled_on=TODAY,
            pool_id=invest.id, actor="pytest", platform_fee=Decimal("20"),
        )
        deposit = service.create_deposit(
            seeded_db, pool_id=invest.id, amount=Decimal("80"), paid_on=TODAY,
            actor="pytest", source_order_id=order_id,
        )
        service.return_deposit(
            seeded_db, deposit.id, amount=Decimal("30"), released_on=TODAY, actor="pytest"
        )

        response = seeded_client.get("/api/v1/cashflows", headers=headers)

        assert response.status_code == 200, response.text
        rows = response.json()
        assert {row["category"] for row in rows} >= {"BUY", "REBATE", "DEPOSIT_HOLD"}
        assert all("order_no" in row for row in rows)
        assert all(row["order_no"] is not None for row in rows)
        assert all("occurred_at" in row and row["occurred_at"] for row in rows)
        assert all("operator" in row and row["operator"] for row in rows)
        assert {row["source"] for row in rows} >= {"ORDER_EVENT", "REBATE_SETTLEMENT", "DEPOSIT"}
        deposit_rows = [row for row in rows if row["source"] == "DEPOSIT"]
        assert {row["deposit_id"] for row in deposit_rows} == {deposit.id}

    def test_list_deposits_endpoint(self, seeded_client, seeded_db, headers):
        invest = _pool(seeded_db, "HJ_INVEST")
        order_id = _active_order(seeded_db)
        service.create_deposit(
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
        deposit = service.create_deposit(
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
        service.create_rebate(
            seeded_db, source_order_id=order_id, rebate_type="BUY", base_amount=Decimal("100"),
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
                "base_amount": "300",
                "collected_on": TODAY.isoformat(),
                "rate": "5",
                "rebate_type": "BUY",
                "channel": "WECHAT",
            },
            headers=headers,
        )
        assert response.status_code == 201, response.text
        assert response.json()["source_order_id"] == order_id
        assert response.json()["rebate_type"] == "BUY"
        assert response.json()["channel"] == "WECHAT"

    def test_settle_rebate_endpoint(self, seeded_client, seeded_db, headers):
        invest = _pool(seeded_db, "HJ_INVEST")
        order_id = _active_order(seeded_db)
        record = service.create_rebate(
            seeded_db, source_order_id=order_id, rebate_type="BUY", base_amount=Decimal("200"),
            collected_on=TODAY, actor="pytest",
        )
        response = seeded_client.post(
            f"/api/v1/rebates/{record.id}/settlements",
            json={
                "gross_amount": "120",
                "settled_on": TODAY.isoformat(),
                "pool_id": invest.id,
                "platform_fee": "20",
                "note": "返点到账",
            },
            headers=headers,
        )
        assert response.status_code == 201, response.text
        assert response.json()["net_amount"] == "100.00"
        assert response.json()["note"] == "返点到账"
        assert response.json()["operator"] == "admin"
        assert response.json()["created_at"]

    def test_rebate_settlement_list_and_reverse_endpoints(
        self, seeded_client, seeded_db, headers
    ):
        invest = _pool(seeded_db, "HJ_INVEST")
        order_id = _active_order(seeded_db)
        record = service.create_rebate(
            seeded_db,
            source_order_id=order_id,
            rebate_type="BUY",
            base_amount=Decimal("100"),
            collected_on=TODAY,
            actor="pytest",
        )
        original = service.settle_rebate(
            seeded_db,
            record.id,
            gross_amount=Decimal("100"),
            settled_on=TODAY,
            pool_id=invest.id,
            actor="pytest",
        )

        reversed_response = seeded_client.post(
            f"/api/v1/rebates/{record.id}/settlements/{original.id}/reverse",
            json={
                "reversed_on": TODAY.isoformat(),
                "reason": "接口更正手续费",
            },
            headers=headers,
        )
        assert reversed_response.status_code == 200, reversed_response.text
        assert reversed_response.json()["reversal_of_id"] == original.id

        listed = seeded_client.get(
            f"/api/v1/rebates/{record.id}/settlements", headers=headers
        )
        assert listed.status_code == 200, listed.text
        assert len(listed.json()) == 2
        assert {row["reversal_of_id"] for row in listed.json()} == {None, original.id}
