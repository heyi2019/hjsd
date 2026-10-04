"""tests/v1/test_orders：订单、事件、现金流派生、划转（A01 / A02 / A03 / A07）。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import ErrorCode
from app.core.numbering import allocate_number
from app.domain.enums import AccountStatus, Direction, EventType, Nature, OrderStatus, SequenceKey
from app.domain.foundation import Pool
from app.domain.trade import Account, Cashflow, Order, OrderEvent
from app.orders import service
from app.parties import service as parties_service

TODAY = date(2026, 10, 4)


def _new_account(seeded_db, *, game_account: str = "acc-001") -> Account:
    account = Account(
        account_no=allocate_number(seeded_db, SequenceKey.ACCOUNT),
        game_account=game_account,
        platform="王者",
        status=AccountStatus.PENDING.value,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(account)
    seeded_db.commit()
    return account


def _customer(seeded_db, name: str = "甲"):
    return parties_service.create_customer(seeded_db, display_name=name, actor="pytest")


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


class TestA01HsStock:
    def test_buy_cost_sell_derives_cost_and_cashflow(self, seeded_db):
        account = _new_account(seeded_db)
        seller = _customer(seeded_db, "卖家甲")
        buyer = _customer(seeded_db, "买家乙")
        seeded_db.commit()

        order = service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
            customer_roles=[(seller.id, "SELLER"), (buyer.id, "BUYER")],
        )
        seeded_db.commit()
        assert order.order_no == "HS0001"
        assert order.status == OrderStatus.DRAFT.value

        service.post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("1000"),
            occurred_on=TODAY, actor="pytest",
        )
        service.post_event(
            seeded_db, order.id, event_type="COST", amount=Decimal("50"),
            occurred_on=TODAY, actor="pytest",
        )
        service.post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("1400"),
            occurred_on=TODAY, actor="pytest", portion="PROFIT",
        )
        seeded_db.commit()

        # 账号成本 = 买入 + 附加成本；售出后释放
        account = seeded_db.get(Account, account.id)
        assert account.cost_amount == Decimal("1050.00")
        assert account.status == AccountStatus.SOLD.value

        # 现金流：BUY/COST 出、SELL 入，且每个事件各一条
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")
        out_flows = _flows(seeded_db, invest.id)
        in_flows = _flows(seeded_db, profit.id)
        assert [str(flow.amount) for flow in out_flows] == ["1000.00", "50.00"]
        assert all(flow.direction == Direction.OUT.value for flow in out_flows)
        assert [str(flow.amount) for flow in in_flows] == ["1400.00"]
        assert in_flows[0].direction == Direction.IN.value

        events = seeded_db.scalars(
            select(OrderEvent).where(OrderEvent.order_id == order.id)
        ).all()
        assert len(events) == 3
        assert len({event.event_no for event in events}) == 3

    def test_duplicate_posting_not_allowed_for_completed_order(self, seeded_db):
        account = _new_account(seeded_db)
        seeded_db.commit()
        order = service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
        )
        seeded_db.commit()
        service.post_event(
            seeded_db, order.id, event_type="DELIVER", occurred_on=TODAY, actor="pytest",
            delivery_mode="PLATFORM_OPERATOR", note="换绑截图IMG_01",
        )
        seeded_db.commit()
        assert seeded_db.get(Order, order.id).status == OrderStatus.COMPLETED.value
        with pytest.raises(Exception) as exc:
            service.post_event(
                seeded_db, order.id, event_type="SELL", amount=Decimal("100"),
                occurred_on=TODAY, actor="pytest",
            )
        assert exc.value.code == ErrorCode.ORDER_STATUS_CONFLICT


class TestA02ThPassthru:
    def test_advance_then_settle(self, seeded_db):
        peer = parties_service.create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        buyer = _customer(seeded_db)
        seeded_db.commit()
        order = service.create_order(
            seeded_db,
            order_type="TH",
            trade_date=TODAY,
            actor="pytest",
            customer_roles=[(buyer.id, "BUYER")],
            counterparty_roles=[(peer.id, "PEER")],
        )
        seeded_db.commit()

        service.post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("1000"),
            occurred_on=TODAY, actor="pytest",
        )
        seeded_db.commit()
        assert service.th_unsettled_advance(seeded_db) == Decimal("1000.00")

        service.post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("1100"),
            occurred_on=TODAY, actor="pytest", portion="PROFIT",
        )
        seeded_db.commit()
        assert service.th_unsettled_advance(seeded_db) == Decimal("0.00")
        # TH 不进库存：无账号也允许过账
        assert seeded_db.get(Order, order.id).account_id is None


class TestA03DgZeroCapital:
    def test_service_income_routes_to_profit_pool(self, seeded_db):
        consignor = _customer(seeded_db, "委托方")
        seeded_db.commit()
        order = service.create_order(
            seeded_db,
            order_type="DG",
            trade_date=TODAY,
            actor="pytest",
            customer_roles=[(consignor.id, "CONSIGNOR")],
        )
        seeded_db.commit()
        assert seeded_db.get(Order, order.id).capital_type == "ZERO"

        service.post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("200"),
            occurred_on=TODAY, actor="pytest", portion="GROSS",
        )
        seeded_db.commit()
        profit = _pool(seeded_db, "HJ_PROFIT")
        flows = _flows(seeded_db, profit.id)
        assert len(flows) == 1
        assert str(flows[0].amount) == "200.00"
        assert flows[0].nature == Nature.BUSINESS_IN.value


class TestA07Transfer:
    def test_transfer_creates_paired_internal_flows(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")
        out_flow, in_flow = service.transfer(
            seeded_db,
            source_pool_id=invest.id,
            target_pool_id=profit.id,
            amount=Decimal("500"),
            occurred_on=TODAY,
            actor="pytest",
        )
        seeded_db.commit()

        assert out_flow.transfer_id == in_flow.transfer_id
        assert out_flow.direction == Direction.OUT.value
        assert in_flow.direction == Direction.IN.value
        assert out_flow.amount == in_flow.amount == Decimal("500.00")
        assert out_flow.nature == Nature.INTERNAL.value

        # 合并现金头寸不变
        invest_balance = service.pool_balance(seeded_db, invest.id)
        profit_balance = service.pool_balance(seeded_db, profit.id)
        assert invest_balance["cash_balance"] == Decimal("-500.00")
        assert profit_balance["cash_balance"] == Decimal("500.00")
        assert invest_balance["cash_balance"] + profit_balance["cash_balance"] == 0

    def test_same_pool_transfer_rejected(self, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        with pytest.raises(Exception) as exc:
            service.transfer(
                seeded_db,
                source_pool_id=invest.id,
                target_pool_id=invest.id,
                amount=Decimal("10"),
                occurred_on=TODAY,
                actor="pytest",
            )
        assert exc.value.code == ErrorCode.VALIDATION_ERROR


class TestEventRules:
    def test_deliver_generates_no_cashflow(self, seeded_db):
        account = _new_account(seeded_db)
        seeded_db.commit()
        order = service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
        )
        seeded_db.commit()
        event, flow = service.post_event(
            seeded_db, order.id, event_type="DELIVER", occurred_on=TODAY, actor="pytest",
            delivery_mode="CUSTOMER_SELF", note="客户自行换绑凭证",
        )
        seeded_db.commit()
        assert flow is None
        assert event.amount == Decimal("0.00")
        assert seeded_db.scalar(
            select(Cashflow).where(Cashflow.order_event_id == event.id)
        ) is None

    def test_deliver_requires_mode_and_voucher(self, seeded_db):
        order = service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest"
        )
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            service.post_event(
                seeded_db, order.id, event_type="DELIVER", occurred_on=TODAY, actor="pytest"
            )
        assert exc.value.code == ErrorCode.DELIVERY_CONDITION_UNMET

    def test_missing_route_blocks_posting(self, seeded_db):
        order = service.create_order(
            seeded_db, order_type="DG", trade_date=TODAY, actor="pytest"
        )
        seeded_db.commit()
        # DG 无 PRINCIPAL 路由（零本金业务不需要本金池）
        with pytest.raises(Exception) as exc:
            service.post_event(
                seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
                occurred_on=TODAY, actor="pytest", portion="PRINCIPAL",
            )
        assert exc.value.code == ErrorCode.POOL_ROUTE_MISSING

    def test_disabled_participant_rejected(self, seeded_db):
        customer = _customer(seeded_db)
        seeded_db.commit()
        parties_service.set_customer_status(seeded_db, customer.id, "DISABLED", actor="pytest")
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            service.create_order(
                seeded_db,
                order_type="HS",
                trade_date=TODAY,
                actor="pytest",
                customer_roles=[(customer.id, "SELLER")],
            )
        assert exc.value.code == ErrorCode.CUSTOMER_DISABLED


class TestOrdersApi:
    def test_create_order_and_post_event(self, seeded_client, headers):
        created = seeded_client.post(
            "/api/v1/orders",
            json={"order_type": "HS", "trade_date": TODAY.isoformat()},
            headers=headers,
        )
        assert created.status_code == 201
        order = created.json()
        assert order["order_no"] == "HS0001"

        event = seeded_client.post(
            f"/api/v1/orders/{order['id']}/events",
            json={
                "event_type": "SELL",
                "amount": "1400.00",
                "occurred_on": TODAY.isoformat(),
                "portion": "PROFIT",
            },
            headers=headers,
        )
        assert event.status_code == 201
        body = event.json()
        assert body["cashflow_no"].startswith("HJF")
        assert body["event"]["event_type"] == "SELL"

    def test_viewer_cannot_post_event(self, seeded_client, headers, viewer_headers):
        order = seeded_client.post(
            "/api/v1/orders",
            json={"order_type": "HS", "trade_date": TODAY.isoformat()},
            headers=headers,
        ).json()
        response = seeded_client.post(
            f"/api/v1/orders/{order['id']}/events",
            json={
                "event_type": "SELL",
                "amount": "100.00",
                "occurred_on": TODAY.isoformat(),
                "portion": "PROFIT",
            },
            headers=viewer_headers,
        )
        assert response.status_code == 403
        assert response.json()["code"] == ErrorCode.PERMISSION_DENIED

    def test_transfer_endpoint(self, seeded_client, headers, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")
        response = seeded_client.post(
            "/api/v1/transfers",
            json={
                "source_pool_id": invest.id,
                "target_pool_id": profit.id,
                "amount": "500.00",
                "occurred_on": TODAY.isoformat(),
            },
            headers=headers,
        )
        assert response.status_code == 201
        body = response.json()
        assert body["out_flow_no"] == body["transfer_id"]
        assert body["in_flow_no"].endswith("-I")

    def test_pool_balance_endpoint(self, seeded_client, headers, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        balance = seeded_client.get(
            f"/api/v1/pools/{invest.id}/balance", headers=headers
        ).json()
        assert balance["pool_code"] == "HJ_INVEST"
        assert balance["cash_balance"] == "0.00"
