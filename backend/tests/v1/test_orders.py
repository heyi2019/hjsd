"""tests/v1/test_orders：订单、事件、现金流派生（A01 / A02 / A03）。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import ErrorCode, NotFound, Validation
from app.core.numbering import allocate_number
from app.domain.enums import AccountStatus, Direction, EventType, Nature, OrderStatus, SequenceKey
from app.domain.foundation import Pool
from app.domain.trade import Account, Cashflow, Installment, Order, OrderEvent
from app.installments import service as installment_service
from app.orders import service
from app.parties import service as parties_service

TODAY = date(2026, 10, 4)


def _new_account(seeded_db, *, game_account: str = "acc-001") -> Account:
    account = Account(
        inventory_no=allocate_number(seeded_db, SequenceKey.ACCOUNT),
        game_account=game_account,
        platform="王者",
        business_mode="SELF" if game_account != "th-stock-acc" else "DISTRIBUTION",
        inventory_type="RECOVERY" if game_account != "th-stock-acc" else "PICKUP",
        status=AccountStatus.IN_STOCK.value,
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


def _settled_hs_installment(seeded_db):
    account = _new_account(seeded_db, game_account="delivery-account")
    order = service.create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    service.post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("500"),
        occurred_on=TODAY, actor="pytest",
    )
    contract = installment_service.create_installment(
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
    installment_service.pay(
        seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
        period_no=0, actor="pytest",
    )
    installment_service.pay(
        seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
        period_no=1, actor="pytest",
    )
    return order


class TestA01HsStock:
    def test_sell_requires_recovered_account(self, seeded_db):
        account = _new_account(seeded_db, game_account="pending-only")
        order = service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
        )
        with pytest.raises(Exception) as exc:
            service.post_event(
                seeded_db,
                order.id,
                event_type="SELL",
                amount=Decimal("100"),
                occurred_on=TODAY,
                actor="pytest",
                portion="PROFIT",
            )
        assert "采购入库" in str(exc.value)

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
        assert order.status == OrderStatus.ACTIVE.value  # 创建即 ACTIVE（草稿态已移除）

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
        assert events[0].event_no == f"{order.order_no}-EV-BUY-01"
        assert out_flows[0].flow_no == f"{order.order_no}-CF-BUY-01"
        assert out_flows[1].flow_no == f"{order.order_no}-CF-COST-01"
        assert in_flows[0].flow_no == f"{order.order_no}-CF-SELL-01"

    def test_cost_cashflow_uses_its_business_category_in_number(self, seeded_db):
        account = _new_account(seeded_db)
        seeded_db.commit()
        order = service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
        )
        seeded_db.commit()

        _event, flow = service.post_event(
            seeded_db,
            order.id,
            event_type="COST",
            amount=Decimal("50"),
            occurred_on=TODAY,
            actor="pytest",
            flow_category="FEE",
        )

        assert flow is not None
        assert flow.category == "FEE"
        assert flow.flow_no == f"{order.order_no}-CF-FEE-01"

    def test_duplicate_posting_not_allowed_for_completed_order(self, seeded_db):
        order = _settled_hs_installment(seeded_db)
        installment_service.deliver(
            seeded_db,
            seeded_db.scalar(
                select(Installment).where(Installment.order_id == order.id)
            ).id,
            delivery_mode="PLATFORM_OPERATOR",
            delivered_on=TODAY,
            note="换绑截图IMG_01",
            actor="pytest",
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
    def test_th_order_keeps_account_as_text_snapshot(self, seeded_db):
        order = service.create_order(
            seeded_db,
            order_type="TH",
            trade_date=TODAY,
            actor="pytest",
            account_snapshot={
                "game_type": "王者荣耀",
                "game_account": "th-text-account",
                "game_password": "secret",
                "channel_region": "安卓一区",
            },
        )
        service.post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount=Decimal("1000"),
            occurred_on=TODAY,
            actor="pytest",
        )
        seeded_db.commit()

        assert seeded_db.get(Order, order.id).account_id is None
        assert seeded_db.get(Order, order.id).account_snapshot["game_account"] == "th-text-account"

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
        service.post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("1100"),
            occurred_on=TODAY, actor="pytest", portion="PROFIT",
        )
        seeded_db.commit()
        # 提号只保留订单文本，不建立库存账号关联。
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


class TestEventRules:
    def test_dg_cannot_post_buy_or_cost(self, seeded_db):
        order = service.create_order(
            seeded_db, order_type="DG", trade_date=TODAY, actor="pytest"
        )

        for event_type in ("BUY", "COST"):
            with pytest.raises(Validation) as exc:
                service.post_event(
                    seeded_db,
                    order.id,
                    event_type=event_type,
                    amount=Decimal("100"),
                    occurred_on=TODAY,
                    actor="pytest",
                )
            assert "代挂业务不允许" in str(exc.value)

    def test_th_sell_requires_a_posted_buy(self, seeded_db):
        order = service.create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest"
        )

        with pytest.raises(Validation) as exc:
            service.post_event(
                seeded_db,
                order.id,
                event_type="SELL",
                amount=Decimal("100"),
                occurred_on=TODAY,
                actor="pytest",
            )

        assert "BUY" in str(exc.value)

    def test_th_order_accepts_only_one_sell_event(self, seeded_db):
        order = service.create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest"
        )
        buy, _ = service.post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount=Decimal("100"),
            occurred_on=TODAY,
            actor="pytest",
        )
        with pytest.raises(Validation, match="offset_event_id"):
            service.post_event(
                seeded_db,
                order.id,
                event_type="SELL",
                amount=Decimal("120"),
                occurred_on=TODAY,
                actor="pytest",
            )
        service.post_event(
            seeded_db,
            order.id,
            event_type="SELL",
            amount=Decimal("120"),
            occurred_on=TODAY,
            actor="pytest",
            offset_event_id=buy.id,
        )

        with pytest.raises(Validation, match="只能登记一次 SELL"):
            service.post_event(
                seeded_db,
                order.id,
                event_type="SELL",
                amount=Decimal("10"),
                occurred_on=TODAY,
                actor="pytest",
                offset_event_id=buy.id,
            )

    def test_dfq_buy_requires_advance_purchase_contract(self, seeded_db):
        order = service.create_order(
            seeded_db, order_type="DFQ", trade_date=TODAY, actor="pytest"
        )

        with pytest.raises(Validation, match="ADVANCE_PURCHASE"):
            service.post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount=Decimal("100"),
                occurred_on=TODAY,
                actor="pytest",
            )

    def test_dfq_cannot_post_sell(self, seeded_db):
        order = service.create_order(
            seeded_db, order_type="DFQ", trade_date=TODAY, actor="pytest"
        )
        installment_service.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type="ADVANCE_PURCHASE",
            principal=Decimal("100"),
            down_payment=Decimal("0"),
            periods=1,
            per_period=Decimal("100"),
            first_due_on=TODAY,
            actor="pytest",
        )
        service.post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount=Decimal("100"),
            occurred_on=TODAY,
            actor="pytest",
        )

        with pytest.raises(Validation) as exc:
            service.post_event(
                seeded_db,
                order.id,
                event_type="SELL",
                amount=Decimal("120"),
                occurred_on=TODAY,
                actor="pytest",
            )

        assert "PAYMENT" in str(exc.value)

    def test_payment_requires_a_source_installment(self, seeded_db):
        order = service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest"
        )

        with pytest.raises(Validation) as exc:
            service.post_event(
                seeded_db,
                order.id,
                event_type="PAYMENT",
                amount=Decimal("100"),
                occurred_on=TODAY,
                actor="pytest",
            )

        assert "分期合约" in str(exc.value)

    def test_unknown_account_is_rejected_before_database_flush(self, seeded_db):
        with pytest.raises(NotFound) as exc:
            service.create_order(
                seeded_db,
                order_type="HS",
                trade_date=TODAY,
                actor="pytest",
                account_id=999999,
            )

        assert exc.value.details == {"account_id": 999999}

    def test_invalid_participant_roles_are_rejected_before_database_flush(self, seeded_db):
        customer = _customer(seeded_db)
        with pytest.raises(Validation) as exc:
            service.create_order(
                seeded_db,
                order_type="HS",
                trade_date=TODAY,
                actor="pytest",
                customer_roles=[(customer.id, "INVALID")],
            )

        assert exc.value.code == ErrorCode.PARTICIPANT_ROLE_INVALID

    def test_deliver_generates_no_cashflow(self, seeded_db):
        order = _settled_hs_installment(seeded_db)
        contract = seeded_db.scalar(
            select(Installment).where(Installment.order_id == order.id)
        )
        assert contract is not None
        installment_service.deliver(
            seeded_db,
            contract.id,
            delivery_mode="CUSTOMER_SELF",
            delivered_on=TODAY,
            note="客户自行换绑凭证",
            actor="pytest",
        )
        event = seeded_db.scalar(
            select(OrderEvent)
            .where(
                OrderEvent.order_id == order.id,
                OrderEvent.event_type == EventType.DELIVER.value,
            )
            .order_by(OrderEvent.id.desc())
        )
        flow = None
        assert event is not None
        seeded_db.commit()
        assert flow is None
        assert event.amount == Decimal("0.00")
        assert seeded_db.scalar(
            select(Cashflow).where(Cashflow.order_event_id == event.id)
        ) is None

    def test_direct_deliver_event_cannot_bypass_installment_service(self, seeded_db):
        order = _settled_hs_installment(seeded_db)
        with pytest.raises(Exception, match="分期交付流程"):
            service.post_event(
                seeded_db,
                order.id,
                event_type=EventType.DELIVER.value,
                occurred_on=TODAY,
                actor="pytest",
                delivery_mode="CUSTOMER_SELF",
                note="客户自行换绑凭证",
            )

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
        # DG 是零本金业务，业务事件组合先于资金路由校验拦截 BUY。
        with pytest.raises(Exception) as exc:
            service.post_event(
                seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
                occurred_on=TODAY, actor="pytest", portion="PRINCIPAL",
            )
        assert exc.value.code == ErrorCode.VALIDATION_ERROR

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
    def test_invalid_money_input_returns_business_422(self, seeded_client, headers):
        created = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": TODAY.isoformat(),
                "account": {"game_account": "api-invalid-money", "platform": "王者"},
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text

        response = seeded_client.post(
            f"/api/v1/orders/{created.json()['id']}/events",
            json={
                "event_type": "BUY",
                "amount": "-1.00",
                "occurred_on": TODAY.isoformat(),
            },
            headers=headers,
        )

        assert response.status_code == 422
        assert response.json()["code"] == ErrorCode.VALIDATION_ERROR

    def test_create_order_and_post_event(self, seeded_client, headers):
        created = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": TODAY.isoformat(),
                "account": {
                    "game_account": "api-sale-account",
                    "platform": "王者",
                },
            },
            headers=headers,
        )
        assert created.status_code == 201
        order = created.json()
        assert order["order_no"] == "HS0001"
        assert order["account_id"]

        buy = seeded_client.post(
            f"/api/v1/orders/{order['id']}/events",
            json={
                "event_type": "BUY",
                "amount": "1000.00",
                "occurred_on": TODAY.isoformat(),
                "portion": "PRINCIPAL",
            },
            headers=headers,
        )
        assert buy.status_code == 201

        event = seeded_client.post(
            f"/api/v1/orders/{order['id']}/events",
            json={
                "event_type": "SELL",
                "amount": "1400.00",
                "occurred_on": TODAY.isoformat(),
                "portion": "PROFIT",
                "reason": "买家确认收款",
                "note": "售出动作备注",
            },
            headers=headers,
        )
        assert event.status_code == 201
        body = event.json()
        assert body["cashflow_no"] == "HS0001-CF-SELL-01"
        assert body["event"]["event_type"] == "SELL"
        assert body["event"]["reason"] == "买家确认收款"
        assert body["event"]["note"] == "售出动作备注"
        assert body["event"]["offset_event_id"] is None
        assert body["event"]["created_at"]
        assert body["event"]["posted_at"]

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

    def test_pool_balance_endpoint(self, seeded_client, headers, seeded_db):
        invest = _pool(seeded_db, "HJ_INVEST")
        balance = seeded_client.get(
            f"/api/v1/pools/{invest.id}/balance", headers=headers
        ).json()
        assert balance["pool_code"] == "HJ_INVEST"
        assert balance["cash_balance"] == "0.00"
