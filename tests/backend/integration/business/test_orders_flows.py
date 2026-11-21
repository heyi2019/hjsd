"""ORDER-01 tests/backend/test_orders：订单、事件、现金流派生（A01 / A02 / A03）。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select
from app.core.errors import ErrorCode, Validation
from app.domain.enums import AccountStatus, Direction, OrderStatus
from app.domain.foundation import Pool
from app.settings.field_definitions.order_types import get_order_type_by_code
from app.domain.trade import Account, Cashflow, Installment, Order, OrderEvent
from app.business.installments import create as inst_create
from app.business.installments import recovery as inst_recovery
from app.business.installments.repayments.pay import pay as inst_pay
from app.business.create import create_order
from app.business.events import post_event
from app.customers.counterparties import create_counterparty
from app.customers.customers import create_customer

TODAY = date(2026, 10, 4)
TODAY2 = date(2026, 10, 18)


def _new_account(seeded_db, *, game_account: str = "acc-001") -> Account:
    account = Account(
        game_account=game_account,
        business_mode="SELF" if game_account != "th-stock-acc" else "DISTRIBUTION",
        inventory_type="RECOVERY" if game_account != "th-stock-acc" else "PICKUP",
        status=AccountStatus.WAITING.value,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(account)
    seeded_db.commit()
    return account

def _customer(seeded_db, name: str = "甲"):
    return create_customer(seeded_db, display_name=name, actor="pytest")

def _pool(seeded_db, code: str) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == code))
    assert pool is not None
    return pool

def _flows(seeded_db, pool_id: int) -> list[Cashflow]:
    return list(
        seeded_db.scalars(
            select(Cashflow).where(Cashflow.pool_id == pool_id).order_by(Cashflow.id)
        ).all()
    )

def _settled_hs_installment(seeded_db):
    account = _new_account(seeded_db, game_account="delivery-account")
    order = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("500"),
        occurred_on=TODAY, actor="pytest",
    )
    contract = inst_create.create_installment(
        seeded_db,
        order_id=order.id,
        contract_type="STOCK_SALE",
        principal=Decimal("600"),
        down_payment=Decimal("100"),
        periods=1,
        per_period=Decimal("500"),
        first_due_on=TODAY,
        actor="pytest",
    )
    inst_pay(
        seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
        period_no=0, actor="pytest",
    )
    inst_pay(
        seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
        period_no=1, actor="pytest",
    )
    return order


def _account(seeded_db, *, game_account: str = "b4-acc", status: str = "WAITING") -> Account:
    acc = Account(
        game_account=game_account,
        business_mode="SELF",
        inventory_type="RECOVERY",
        status=status,
        stock_no="KU_B4_" + game_account[-4:].upper(),
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(acc)
    seeded_db.commit()
    return acc

def _hs_order(seeded_db, *, account: Account | None = None) -> Order:
    return create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
        account_id=account.id if account is not None else None,
    )

def _buy(seeded_db, order: Order, *, amount: str = "500", occurred: date = TODAY,
         pool_id: int | None = None):
    return post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal(amount),
        occurred_on=occurred, actor="pytest", pool_id=pool_id,
    )

def _sell(seeded_db, order: Order, *, amount: str = "800", occurred: date = TODAY2,
          pool_id: int | None = None):
    return post_event(
        seeded_db, order.id, event_type="SELL", amount=Decimal(amount),
        occurred_on=occurred, actor="pytest", pool_id=pool_id,
    )


class TestA01HsStock:
    def test_sell_requires_recovered_account(self, seeded_db):
        account = _new_account(seeded_db, game_account="pending-only")
        order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
        )
        with pytest.raises(Exception) as exc:
            post_event(
                seeded_db,
                order.id,
                event_type="SELL",
                amount=Decimal("100"),
                occurred_on=TODAY,
                actor="pytest",
                portion="PROFIT",
            )
        assert "采购入库" in str(exc.value)

    def test_buy_sell_derives_cashflow(self, seeded_db):
        account = _new_account(seeded_db)
        seller = _customer(seeded_db, "卖家甲")
        buyer = _customer(seeded_db, "买家乙")
        seeded_db.commit()

        order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
            customer_roles=[(seller.id, "SELLER"), (buyer.id, "BUYER")],
        )
        seeded_db.commit()
        assert order.order_no == "HS0001"
        assert order.status == OrderStatus.ACTIVE.value  # 创建即 ACTIVE（草稿态已移除）

        post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("1000"),
            occurred_on=TODAY, actor="pytest",
        )
        post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("1400"),
            occurred_on=TODAY, actor="pytest", portion="PROFIT",
        )
        seeded_db.commit()

        # 账号成本只由 BUY 采购事实形成；售出后释放
        account = seeded_db.get(Account, account.id)
        assert account.cost_amount == Decimal("1000.00")
        assert account.status == AccountStatus.SOLD.value

        # 现金流：BUY 出、SELL 入，删除路由后统一落默认池（HJ_INVEST，is_default）
        invest = _pool(seeded_db, "HJ_INVEST")
        flows = _flows(seeded_db, invest.id)
        assert [str(flow.amount) for flow in flows] == ["1000.00", "1400.00"]
        assert flows[0].direction == Direction.OUT.value
        assert flows[0].accounting_attribute == "SELF_DIRECT_COST"
        assert flows[1].direction == Direction.IN.value
        assert flows[1].accounting_attribute == "SELF_REVENUE"

        events = seeded_db.scalars(
            select(OrderEvent).where(OrderEvent.order_id == order.id)
        ).all()
        assert len(events) == 2
        assert len({event.event_no for event in events}) == 2
        assert events[0].event_no == f"{order.order_no}-EV-BUY-01"
        assert flows[0].flow_no == "ZC00001"
        assert flows[1].flow_no == "SR00001"

    def test_cost_event_is_removed(self, seeded_db):
        order = create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest"
        )
        with pytest.raises(Validation, match="事件类型必须为"):
            post_event(
                seeded_db, order.id, event_type="COST", amount=Decimal("50"),
                occurred_on=TODAY, actor="pytest",
            )

    def test_duplicate_posting_not_allowed_for_completed_order(self, seeded_db):
        order = _settled_hs_installment(seeded_db)
        inst_recovery.deliver(
            seeded_db,
            seeded_db.scalar(
                select(Installment).where(Installment.order_id == order.id)
            ).id,
            delivered_on=TODAY,
            note="换绑截图IMG_01",
            actor="pytest",
        )
        seeded_db.commit()
        assert seeded_db.get(Order, order.id).status == OrderStatus.COMPLETED.value
        with pytest.raises(Exception) as exc:
            post_event(
                seeded_db, order.id, event_type="SELL", amount=Decimal("100"),
                occurred_on=TODAY, actor="pytest",
            )
        assert exc.value.code == ErrorCode.ORDER_STATUS_CONFLICT

class TestA02ThStock:
    def test_th_order_keeps_inventory_link_without_snapshot(self, seeded_db):
        account = _new_account(seeded_db, game_account="th-stock-acc")
        order = create_order(
            seeded_db,
            order_type="TH",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
        )
        post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount=Decimal("1000"),
            occurred_on=TODAY,
            actor="pytest",
        )
        seeded_db.commit()

        assert seeded_db.get(Order, order.id).account_id == account.id
        assert seeded_db.get(Order, order.id).account_snapshot is None

    def test_advance_then_settle(self, seeded_db):
        peer = create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        buyer = _customer(seeded_db)
        account = _new_account(seeded_db, game_account="th-stock-acc")
        seeded_db.commit()
        order = create_order(
            seeded_db,
            order_type="TH",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
            customer_roles=[(buyer.id, "BUYER")],
            counterparty_roles=[(peer.id, "PEER")],
        )
        seeded_db.commit()

        post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("1000"),
            occurred_on=TODAY, actor="pytest",
        )
        seeded_db.commit()
        post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("1100"),
            occurred_on=TODAY, actor="pytest", portion="PROFIT",
        )
        seeded_db.commit()

class TestA03DgZeroCapital:
    def test_service_income_goes_to_default_pool(self, seeded_db):
        consignor = _customer(seeded_db, "委托方")
        seeded_db.commit()
        order = create_order(
            seeded_db,
            order_type="DG",
            trade_date=TODAY,
            actor="pytest",
            customer_roles=[(consignor.id, "CONSIGNOR")],
        )
        seeded_db.commit()
        # 零本金由业务类型标记表达：DG 标记 is_zero_principal，登记本金支出会被拒。
        definition = get_order_type_by_code(seeded_db, "DG")
        assert definition is not None and definition.is_zero_principal is True
        with pytest.raises(Validation, match="不允许 BUY 事件"):
            post_event(
                seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
                occurred_on=TODAY, actor="pytest", portion="PRINCIPAL",
            )

        post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("200"),
            occurred_on=TODAY, actor="pytest", portion="GROSS",
        )
        seeded_db.commit()
        # 删除路由后 DG 服务收入落默认池（不再分利润池）
        default_pool = _pool(seeded_db, "HJ_INVEST")
        flows = _flows(seeded_db, default_pool.id)
        assert len(flows) == 1
        assert str(flows[0].amount) == "200.00"
