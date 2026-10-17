"""对抗性探针：专挑边界、非法路径与状态机越界。

本文件的断言代表「应有的防护」。任何 FAIL 都是真实缺陷，需修复而不是改断言。
"""
from __future__ import annotations

from datetime import date
from uuid import uuid4

from app.accounts import service as account_service
import pytest

from app.core.money import to_money
from app.finance import service as finance_service
from app.installments import service as installment_service
from app.orders import service as order_service
from app.parties import service as party_service

D = date(2026, 10, 4)


def _order(seeded_db, order_type: str = "HS", **kw):
    if order_type == "HS" and kw.get("account_id") is None:
        account = account_service.create_account(
            seeded_db,
            game_account=f"hunt-{uuid4().hex[:12]}",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="hunt",
        )
        kw["account_id"] = account.id
    return order_service.create_order(
        seeded_db, order_type=order_type, trade_date=D, actor="hunt", **kw
    )


# ------------------------------------------------------------------ 金额与精度
class TestMoneyEdge:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("0.005", "0.01"),  # 半进位
            ("1234567890123456.78", "1234567890123456.78"),  # 16 位整数
            ("0.01", "0.01"),
            ("-0.00", "0.00"),
            ("1e3", "1000.00"),
        ],
    )
    def test_amount_roundtrip(self, raw, expected):
        assert str(to_money(raw)) == expected

    def test_float_never_leaks_binary_tail(self, seeded_db):
        """float 输入先经 str() 再 Decimal：不得出现二进制尾差。"""
        order = _order(seeded_db)
        event, _flow = order_service.post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount=0.1 + 0.2,  # 显式 float，二进制下为 0.30000000000000004
            occurred_on=D,
            actor="hunt",
        )
        assert str(event.amount) == "0.30"


# ------------------------------------------------------------------ 订单状态机
class TestOrderStateMachine:
    def test_cannot_post_to_cancelled_order(self, seeded_db):
        order = _order(seeded_db, order_type="TH")
        buy, _ = order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="hunt",
        )
        order_service.post_event(
            seeded_db,
            order.id,
            event_type="CANCEL",
            amount="100.00",
            occurred_on=D,
            actor="hunt",
            offset_event_id=buy.id,
            reason="同行未付成功",
        )
        with pytest.raises(Exception):
            order_service.post_event(
                seeded_db, order.id, event_type="BUY", amount="100", occurred_on=D, actor="hunt"
            )

    def test_negative_amount_is_rejected(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Exception):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount="-100.00",
                occurred_on=D,
                actor="hunt",
            )

    def test_zero_amount_is_rejected(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Exception):
            order_service.post_event(
                seeded_db, order.id, event_type="BUY", amount="0", occurred_on=D, actor="hunt"
            )

    def test_same_event_cannot_derive_two_cashflows(self, seeded_db):
        """事件→现金流必须一对一：重复过账同一事件不允许。"""
        order = _order(seeded_db)
        event, flow = order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="500", occurred_on=D, actor="hunt"
        )
        assert flow is not None
        from sqlalchemy import func, select

        from app.domain.trade import Cashflow

        count = seeded_db.scalar(
            select(func.count(Cashflow.id)).where(Cashflow.order_event_id == event.id)
        )
        assert count == 1

    def test_deliver_without_mode_or_evidence_is_rejected(self, seeded_db):
        """DELIVER 必须记录 delivery_mode（M2 硬性要求）。"""
        order = _order(seeded_db)
        with pytest.raises(Exception):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="DELIVER",
                occurred_on=D,
                actor="hunt",
            )


# ------------------------------------------------------------------ 分期
class TestInstallment:
    def _contract(self, seeded_db, contract_type: str = "STOCK_SALE"):
        """先买入使账号在库，STOCK_SALE 才有可用账号。"""
        from app.accounts import service as account_service

        account = account_service.create_account(
            seeded_db,
            game_account="hunt-acc",
            platform="王者",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="hunt",
        )
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        order_service.post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount="1200.00",
            occurred_on=D,
            actor="hunt",
        )
        return installment_service.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type=contract_type,
            principal="1200.00",
            down_payment="0",
            periods=3,
            first_due_on=D,
            actor="hunt",
        )

    def test_hs_cannot_use_advance_purchase(self, seeded_db):
        """STOCK_SALE 仅 HS、ADVANCE_PURCHASE 仅 DFQ，两者不能混用。"""
        order = _order(seeded_db, order_type="HS")
        with pytest.raises(Exception):
            installment_service.create_installment(
                seeded_db,
                order_id=order.id,
                contract_type="ADVANCE_PURCHASE",
                principal="1200.00",
                down_payment="0",
                periods=3,
                first_due_on=D,
                actor="hunt",
            )

    def test_dfq_cannot_use_stock_sale(self, seeded_db):
        order = _order(seeded_db, order_type="DFQ")
        with pytest.raises(Exception):
            installment_service.create_installment(
                seeded_db,
                order_id=order.id,
                contract_type="STOCK_SALE",
                principal="1200.00",
                down_payment="0",
                periods=3,
                first_due_on=D,
                actor="hunt",
            )

    def test_overpayment_is_rejected(self, seeded_db):
        contract = self._contract(seeded_db)
        with pytest.raises(Exception):
            installment_service.pay(
                seeded_db, contract.id, amount="99999.00", paid_on=D, actor="hunt"
            )

    def test_payment_zero_is_rejected(self, seeded_db):
        contract = self._contract(seeded_db)
        with pytest.raises(Exception):
            installment_service.pay(
                seeded_db, contract.id, amount="0", paid_on=D, actor="hunt"
            )


# ------------------------------------------------------------------ 押金 / 返点
class TestDepositAndRebate:
    def test_release_more_than_held_is_rejected(self, seeded_db):
        deposit = finance_service.create_deposit(
            seeded_db, pool_id=1, amount="1000.00", paid_on=D, actor="hunt"
        )
        with pytest.raises(Exception):
            finance_service.return_deposit(
                seeded_db, deposit.id, amount="2000.00", released_on=D, actor="hunt"
            )

    def test_negative_deposit_is_rejected(self, seeded_db):
        with pytest.raises(Exception):
            finance_service.create_deposit(
                seeded_db, pool_id=1, amount="-100", paid_on=D, actor="hunt"
            )

    def test_rebate_settle_more_than_receivable_is_rejected(self, seeded_db):
        """可结算上限 = 返点基数 1000；一次结 1200 必须被拒。"""
        order = _order(seeded_db)
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="hunt",
        )
        order_service.post_event(
            seeded_db,
            order.id,
            event_type="SELL",
            amount="1000.00",
            occurred_on=D,
            actor="hunt",
        )
        rebate = finance_service.create_rebate(
            seeded_db,
            source_order_id=order.id,
            base_amount="1000.00",
            rate="5",
            collected_on=D,
            actor="hunt",
        )
        with pytest.raises(Exception):
            finance_service.settle_rebate(
                seeded_db,
                rebate.id,
                gross_amount="1200.00",
                platform_fee="0",
                settled_on=D,
                pool_id=1,
                actor="hunt",
            )

    def test_rebate_partial_then_full_settles(self, seeded_db):
        order = _order(seeded_db)
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="hunt",
        )
        order_service.post_event(
            seeded_db,
            order.id,
            event_type="SELL",
            amount="1000.00",
            occurred_on=D,
            actor="hunt",
        )
        rebate = finance_service.create_rebate(
            seeded_db,
            source_order_id=order.id,
            base_amount="1000.00",
            rate="5",
            collected_on=D,
            actor="hunt",
        )
        finance_service.settle_rebate(
            seeded_db, rebate.id, gross_amount="400.00", platform_fee="0",
            settled_on=D, pool_id=1, actor="hunt",
        )
        seeded_db.refresh(rebate)
        assert rebate.status == "PARTIALLY_SETTLED"
        finance_service.settle_rebate(
            seeded_db, rebate.id, gross_amount="600.00", platform_fee="0",
            settled_on=D, pool_id=1, actor="hunt",
        )
        seeded_db.refresh(rebate)
        assert rebate.status == "SETTLED"


# ------------------------------------------------------------------ 主数据
class TestMasterData:
    def test_disabled_pool_cannot_receive_new_event(self, seeded_db):
        from app.foundation import service as foundation_service

        foundation_service.set_pool_status(seeded_db, 1, "DISABLED", actor="hunt")
        order = _order(seeded_db)
        with pytest.raises(Exception):
            order_service.post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount="100",
                occurred_on=D,
                pool_id=1,
                actor="hunt",
            )

    def test_customer_number_is_not_reused(self, seeded_db):
        first = party_service.create_customer(seeded_db, display_name="甲", actor="hunt")
        merged_target = party_service.create_customer(seeded_db, display_name="乙", actor="hunt")
        party_service.merge_customers(
            seeded_db,
            source_customer_id=first.id,
            target_customer_id=merged_target.id,
            reason="重复建档",
            actor="hunt",
        )
        third = party_service.create_customer(seeded_db, display_name="丙", actor="hunt")
        assert third.customer_no != first.customer_no

    def test_duplicate_phone_raises_candidate(self, seeded_db):
        party_service.create_customer(seeded_db, display_name="甲", phone="13800000001", actor="hunt")
        candidates = party_service.duplicate_candidates(seeded_db, phone="13800000001")
        assert candidates

    def test_counterparty_cannot_be_created_as_customer(self, seeded_db):
        """同行不能被写成客户：类型边界由两张表物理隔离。"""
        peer = party_service.create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="hunt"
        )
        from sqlalchemy import select

        from app.domain.parties import Customer

        found = seeded_db.scalar(
            select(Customer).where(Customer.display_name == "同行A")
        )
        assert found is None
        assert peer.counterparty_no.startswith("CP")
