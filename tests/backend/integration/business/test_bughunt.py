"""ROBUST-01 对抗性探针：专挑边界、非法路径与状态机越界。

本文件的断言代表「应有的防护」。任何 FAIL 都是真实缺陷，需修复而不是改断言。
"""
from __future__ import annotations

from datetime import date
from uuid import uuid4

from app.stocks.profile import create_account
import pytest

from app.core.money import to_money
from app.finance.deposits import create_deposit, return_deposit
from app.value_added_services import service as installment_service
from app.orders.create import create_order
from app.orders.events import post_event
from app.parties.counterparties import create_counterparty
from app.parties.customer_merge import duplicate_candidates, merge_customers
from app.parties.customers import create_customer

D = date(2026, 10, 4)

def _order(seeded_db, order_type: str = "HS", **kw):
    if order_type == "HS" and kw.get("account_id") is None:
        account = create_account(
            seeded_db,
            game_account=f"hunt-{uuid4().hex[:12]}",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="hunt",
        )
        kw["account_id"] = account.id
    return create_order(
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
        event, _flow = post_event(
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
        buy, _ = post_event(
            seeded_db, order.id, event_type="BUY", amount="100.00",
            occurred_on=D, actor="hunt",
        )
        post_event(
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
            post_event(
                seeded_db, order.id, event_type="BUY", amount="100", occurred_on=D, actor="hunt"
            )

    def test_negative_amount_is_rejected(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Exception):
            post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount="-100.00",
                occurred_on=D,
                actor="hunt",
            )

    def test_zero_buy_amount_is_allowed(self, seeded_db):
        # 方案 C：提号号价设为选填留空时前端以 0 兜底，BUY 初始买入金额允许为 0。
        # 负数仍被拒绝（见 test_negative_amount_is_rejected）。
        order = _order(seeded_db)
        event, _ = post_event(
            seeded_db, order.id, event_type="BUY", amount="0", occurred_on=D, actor="hunt"
        )
        assert event.amount == 0

    def test_same_event_cannot_derive_two_cashflows(self, seeded_db):
        """事件→现金流必须一对一：重复登记同一事件不允许。"""
        order = _order(seeded_db)
        event, flow = post_event(
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
            post_event(
                seeded_db,
                order.id,
                event_type="DELIVER",
                occurred_on=D,
                actor="hunt",
            )

# ------------------------------------------------------------------ 提号售出口径
class TestPickupSale:
    """提号账号售出：售出单本身不再重复 BUY，采购事实按账号追溯（与 HS 同口径）。

    库存中心售出提号账号时会另开一张 TH 售出单，BUY 记在提号入库那张订单上；
    若按「本订单必须有 BUY」校验，提号将永远无法售出。
    """

    def _pickup_account(self, seeded_db):
        return create_account(
            seeded_db,
            game_account=f"hunt-pickup-{uuid4().hex[:8]}",
            business_mode="DISTRIBUTION",
            inventory_type="PICKUP",
            actor="hunt",
        )

    def test_sale_order_sells_without_own_buy(self, seeded_db):
        account = self._pickup_account(seeded_db)
        stock_in = create_order(
            seeded_db, order_type="TH", trade_date=D, actor="hunt", account_id=account.id,
        )
        post_event(
            seeded_db, stock_in.id, event_type="BUY", amount="800",
            occurred_on=D, actor="hunt", pool_id=1,
        )
        sale = create_order(
            seeded_db, order_type="TH", trade_date=D, actor="hunt", account_id=account.id,
        )
        event, flow = post_event(
            seeded_db, sale.id, event_type="SELL", amount="1200",
            occurred_on=D, actor="hunt", pool_id=1,
        )
        assert event.event_type == "SELL"
        assert flow is not None

    def test_sale_rejected_when_account_never_bought(self, seeded_db):
        """账号从未采购入库时，售出仍必须被拦截。"""
        account = self._pickup_account(seeded_db)
        sale = create_order(
            seeded_db, order_type="TH", trade_date=D, actor="hunt", account_id=account.id,
        )
        with pytest.raises(Exception, match="BUY"):
            post_event(
                seeded_db, sale.id, event_type="SELL", amount="1200",
                occurred_on=D, actor="hunt", pool_id=1,
            )

# ------------------------------------------------------------------ 分期
class TestInstallment:
    def _contract(self, seeded_db, contract_type: str = "STOCK_SALE"):
        """先买入使账号在库，STOCK_SALE 才有可用账号。"""
        from app.stocks.profile import create_account

        account = create_account(
            seeded_db,
            game_account="hunt-acc",
            platform="王者",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="hunt",
        )
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        post_event(
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
            per_period="400.00",
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
        deposit = create_deposit(
            seeded_db, pool_id=1, amount="1000.00", paid_on=D, actor="hunt"
        )
        with pytest.raises(Exception):
            return_deposit(
                seeded_db, deposit.id, amount="2000.00", released_on=D, actor="hunt"
            )

    def test_negative_deposit_is_rejected(self, seeded_db):
        with pytest.raises(Exception):
            create_deposit(
                seeded_db, pool_id=1, amount="-100", paid_on=D, actor="hunt"
            )

# ------------------------------------------------------------------ 主数据
class TestMasterData:
    def test_disabled_pool_cannot_receive_new_event(self, seeded_db):
        from app.foundation.pools import set_pool_status

        set_pool_status(seeded_db, 1, "DISABLED", actor="hunt")
        order = _order(seeded_db)
        with pytest.raises(Exception):
            post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount="100",
                occurred_on=D,
                pool_id=1,
                actor="hunt",
            )

    def test_customer_number_is_not_reused(self, seeded_db):
        first = create_customer(seeded_db, display_name="甲", actor="hunt")
        merged_target = create_customer(seeded_db, display_name="乙", actor="hunt")
        merge_customers(
            seeded_db,
            source_customer_id=first.id,
            target_customer_id=merged_target.id,
            reason="重复建档",
            actor="hunt",
        )
        third = create_customer(seeded_db, display_name="丙", actor="hunt")
        assert third.customer_no != first.customer_no

    def test_duplicate_phone_raises_candidate(self, seeded_db):
        create_customer(seeded_db, display_name="甲", phone="13800000001", actor="hunt")
        candidates = duplicate_candidates(seeded_db, phone="13800000001")
        assert candidates

    def test_counterparty_cannot_be_created_as_customer(self, seeded_db):
        """同行不能被写成客户：类型边界由两张表物理隔离。"""
        peer = create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="hunt"
        )
        from sqlalchemy import select

        from app.domain.parties import Customer

        found = seeded_db.scalar(
            select(Customer).where(Customer.display_name == "同行A")
        )
        assert found is None
        assert peer.counterparty_no.startswith("CP")
