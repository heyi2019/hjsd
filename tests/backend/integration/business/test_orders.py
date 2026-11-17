"""ORDER-01 tests/backend/test_orders：订单、事件、现金流派生（A01 / A02 / A03）。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.stocks.profile import create_account
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.domain.enums import AccountStatus, Direction, EventType, Nature, OrderStatus
from app.domain.foundation import Pool
from app.domain.parties import OrderCustomerRole
from app.domain.trade import Account, Cashflow, Installment, Order, OrderEvent
from app.value_added_services import create as inst_create
from app.value_added_services import recovery as inst_recovery
from app.value_added_services import repayment as inst_repayment
from app.orders.create import add_customer_role, create_order
from app.orders.events import post_event
from app.parties.counterparties import create_counterparty
from app.parties.customers import create_customer, set_customer_status

TODAY = date(2026, 10, 4)
TODAY2 = date(2026, 10, 18)

def _new_account(seeded_db, *, game_account: str = "acc-001") -> Account:
    account = Account(
        game_account=game_account,
        platform="王者",
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
    inst_repayment.pay(
        seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
        period_no=0, actor="pytest",
    )
    inst_repayment.pay(
        seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
        period_no=1, actor="pytest",
    )
    return order

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

        # 现金流：BUY 出、SELL 入，且每个事件各一条
        invest = _pool(seeded_db, "HJ_INVEST")
        profit = _pool(seeded_db, "HJ_PROFIT")
        out_flows = _flows(seeded_db, invest.id)
        in_flows = _flows(seeded_db, profit.id)
        assert [str(flow.amount) for flow in out_flows] == ["1000.00"]
        assert all(flow.direction == Direction.OUT.value for flow in out_flows)
        assert out_flows[0].accounting_attribute == "SELF_DIRECT_COST"
        assert [str(flow.amount) for flow in in_flows] == ["1400.00"]
        assert in_flows[0].direction == Direction.IN.value
        assert in_flows[0].accounting_attribute == "SELF_REVENUE"

        events = seeded_db.scalars(
            select(OrderEvent).where(OrderEvent.order_id == order.id)
        ).all()
        assert len(events) == 2
        assert len({event.event_no for event in events}) == 2
        assert events[0].event_no == f"{order.order_no}-EV-BUY-01"
        assert out_flows[0].flow_no == "ZC00001"
        assert in_flows[0].flow_no == "SR00001"

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
            delivery_mode="PLATFORM_OPERATOR",
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
        # 提号按普通库存资金处理，不再要求 BUY/SELL 互相核销。
        assert seeded_db.get(Order, order.id).capital_type == "STOCK"

class TestA03DgZeroCapital:
    def test_service_income_routes_to_profit_pool(self, seeded_db):
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
        assert seeded_db.get(Order, order.id).capital_type == "ZERO"

        post_event(
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
    def test_float_event_amount_is_normalized_without_binary_tail(self, seeded_db):
        order = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest")
        event, _ = post_event(
            seeded_db, order.id, event_type="BUY", amount=0.1 + 0.2,
            occurred_on=TODAY, actor="pytest",
        )
        assert str(event.amount) == "0.30"

    def test_negative_event_amount_is_rejected(self, seeded_db):
        order = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest")
        with pytest.raises(Validation):
            post_event(
                seeded_db, order.id, event_type="BUY", amount="-100.00",
                occurred_on=TODAY, actor="pytest",
            )

    def test_zero_buy_amount_is_allowed(self, seeded_db):
        order = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest")
        event, _ = post_event(
            seeded_db, order.id, event_type="BUY", amount="0",
            occurred_on=TODAY, actor="pytest",
        )
        assert event.amount == 0

    def test_cancelled_order_rejects_new_event(self, seeded_db):
        from app.orders.cancellation_model import cancel_order

        order = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest")
        cancel_order(seeded_db, order.id, actor="pytest", reason="撤销空订单")
        with pytest.raises(Conflict):
            post_event(
                seeded_db, order.id, event_type="BUY", amount="100",
                occurred_on=TODAY, actor="pytest",
            )

    def test_pickup_sale_requires_prior_purchase(self, seeded_db):
        account = create_account(
            seeded_db, game_account="pickup-sale-before-buy",
            business_mode="DISTRIBUTION", inventory_type="PICKUP", actor="pytest",
        )
        order = create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest", account_id=account.id,
        )
        with pytest.raises(Validation, match="BUY"):
            post_event(
                seeded_db, order.id, event_type="SELL", amount="1200",
                occurred_on=TODAY, actor="pytest", pool_id=1,
            )

    def test_disabled_pool_rejects_new_order_event(self, seeded_db):
        from app.foundation.pools import set_pool_status

        set_pool_status(seeded_db, 1, "DISABLED", actor="pytest")
        order = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest")
        with pytest.raises(Validation):
            post_event(
                seeded_db, order.id, event_type="BUY", amount="100",
                occurred_on=TODAY, actor="pytest", pool_id=1,
            )

    @pytest.mark.parametrize(("order_type", "inventory_type"), [("HS", "RECOVERY"), ("TH", "PICKUP")])
    def test_inline_purchase_creates_inventory(self, seeded_db, order_type, inventory_type):
        """2026-10-28 口径：建单成功即内联建库存账号（编号已发放），BUY 只累计成本。"""
        order = create_order(
            seeded_db,
            order_type=order_type,
            trade_date=TODAY,
            actor="pytest",
            account_snapshot={"game_account": "inline-recovery-account"},
        )

        assert order.account_id is not None
        account = seeded_db.get(Account, order.account_id)
        assert account is not None
        assert account.game_account == "inline-recovery-account"
        assert account.inventory_type == inventory_type
        assert account.status == "WAITING"
        assert account.cost_amount == Decimal("0.00")

        event, _ = post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount=Decimal("100"),
            occurred_on=TODAY,
            actor="pytest",
        )

        assert event.event_type == "BUY"
        assert account.cost_amount == Decimal("100.00")
        assert account.buy_date == TODAY
        assert account.status == "WAITING"

    def test_inline_consignment_creates_inventory(self, seeded_db):
        order = create_order(
            seeded_db, order_type="DG", trade_date=TODAY, actor="pytest",
            account_snapshot={"game_account": "inline-consignment-account"},
        )
        account = seeded_db.get(Account, order.account_id)
        assert account is not None
        assert account.inventory_type == "CONSIGNMENT"
        assert account.status == "WAITING"
        assert account.cost_amount == Decimal("0.00")

    def test_dg_cannot_post_buy(self, seeded_db):
        order = create_order(
            seeded_db, order_type="DG", trade_date=TODAY, actor="pytest"
        )

        with pytest.raises(Validation, match="代挂业务不允许 BUY"):
            post_event(
                seeded_db,
                order.id,
                event_type="BUY",
                amount=Decimal("100"),
                occurred_on=TODAY,
                actor="pytest",
            )

    def test_cost_is_not_a_th_event(self, seeded_db):
        order = create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest"
        )

        with pytest.raises(Validation, match="事件类型必须为"):
            post_event(
                seeded_db,
                order.id,
                event_type="COST",
                amount=Decimal("100"),
                occurred_on=TODAY,
                actor="pytest",
            )

    def test_hs_cannot_add_removed_cost_event_after_account_is_sold(self, seeded_db):
        account = _new_account(seeded_db, game_account="sold-cost-guard")
        order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=TODAY,
            actor="pytest",
            account_id=account.id,
        )
        post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount=Decimal("100"),
            occurred_on=TODAY,
            actor="pytest",
        )
        post_event(
            seeded_db,
            order.id,
            event_type="SELL",
            amount=Decimal("150"),
            occurred_on=TODAY,
            actor="pytest",
        )

        with pytest.raises(Validation, match="事件类型必须为"):
            post_event(
                seeded_db,
                order.id,
                event_type="COST",
                amount=Decimal("10"),
                occurred_on=TODAY,
                actor="pytest",
            )

    def test_th_sell_requires_a_buy(self, seeded_db):
        account = _new_account(seeded_db, game_account="th-stock-acc")
        order = create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest", account_id=account.id
        )

        with pytest.raises(Validation) as exc:
            post_event(
                seeded_db,
                order.id,
                event_type="SELL",
                amount=Decimal("100"),
                occurred_on=TODAY,
                actor="pytest",
            )

        assert "BUY" in str(exc.value)

    def test_th_order_accepts_only_one_sell_event(self, seeded_db):
        account = _new_account(seeded_db, game_account="th-stock-acc")
        order = create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest", account_id=account.id
        )
        buy, _ = post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount=Decimal("100"),
            occurred_on=TODAY,
            actor="pytest",
        )
        post_event(
            seeded_db,
            order.id,
            event_type="SELL",
            amount=Decimal("120"),
            occurred_on=TODAY,
            actor="pytest",
        )

        with pytest.raises(Validation, match="只能登记一次 SELL"):
            post_event(
                seeded_db,
                order.id,
                event_type="SELL",
                amount=Decimal("10"),
                occurred_on=TODAY,
                actor="pytest",
                offset_event_id=buy.id,
            )

    def test_payment_event_is_removed(self, seeded_db):
        order = create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest"
        )

        with pytest.raises(Validation, match="事件类型必须为"):
            post_event(
                seeded_db,
                order.id,
                event_type="PAYMENT",
                amount=Decimal("100"),
                occurred_on=TODAY,
                actor="pytest",
            )

    def test_unknown_account_is_rejected_before_database_flush(self, seeded_db):
        with pytest.raises(NotFound) as exc:
            create_order(
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
            create_order(
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
        inst_recovery.deliver(
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
            select(Cashflow).where(
                Cashflow.source_type == "ORDER_EVENT", Cashflow.source_id == event.event_no
            )
        ) is None

    def test_full_sale_can_record_sell_delivery_without_cashflow(self, seeded_db):
        account = _new_account(seeded_db, game_account="full-sale-delivery")
        order = create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
        )
        post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
            occurred_on=TODAY, actor="pytest",
        )
        post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("200"),
            occurred_on=TODAY, actor="pytest", portion="PROFIT",
        )
        event, flow = post_event(
            seeded_db,
            order.id,
            event_type="DELIVER",
            delivery_direction="SELL",
            delivery_mode="CUSTOMER_SELF",
            occurred_on=TODAY,
            actor="pytest",
            note="客户自行换绑凭证",
        )
        assert event.event_type == EventType.DELIVER.value
        assert event.form_extra["delivery_direction"] == "SELL"
        assert flow is None
        assert seeded_db.scalar(
            select(Cashflow).where(
                Cashflow.source_type == "ORDER_EVENT", Cashflow.source_id == event.event_no
            )
        ) is None

    def test_dg_sale_can_record_sell_delivery_without_buy(self, seeded_db):
        order = create_order(
            seeded_db, order_type="DG", trade_date=TODAY, actor="pytest"
        )
        post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("200"),
            occurred_on=TODAY, actor="pytest", portion="GROSS",
        )
        event, flow = post_event(
            seeded_db,
            order.id,
            event_type="DELIVER",
            delivery_direction="SELL",
            delivery_mode="PLATFORM_OPERATOR",
            occurred_on=TODAY,
            actor="pytest",
            note="代挂订单交付凭证",
        )
        assert event.form_extra["delivery_direction"] == "SELL"
        assert flow is None

    def test_direct_deliver_event_cannot_bypass_installment_service(self, seeded_db):
        order = _settled_hs_installment(seeded_db)
        with pytest.raises(Exception, match="分期交付流程"):
            post_event(
                seeded_db,
                order.id,
                event_type=EventType.DELIVER.value,
                occurred_on=TODAY,
                actor="pytest",
                delivery_mode="CUSTOMER_SELF",
                note="客户自行换绑凭证",
            )

    def test_deliver_requires_mode_and_voucher(self, seeded_db):
        order = create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest"
        )
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            post_event(
                seeded_db, order.id, event_type="DELIVER", occurred_on=TODAY, actor="pytest"
            )
        assert exc.value.code == ErrorCode.DELIVERY_CONDITION_UNMET

    def test_missing_route_blocks_posting(self, seeded_db):
        order = create_order(
            seeded_db, order_type="DG", trade_date=TODAY, actor="pytest"
        )
        seeded_db.commit()
        # DG 是零本金业务，业务事件组合先于资金路由校验拦截 BUY。
        with pytest.raises(Exception) as exc:
            post_event(
                seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
                occurred_on=TODAY, actor="pytest", portion="PRINCIPAL",
            )
        assert exc.value.code == ErrorCode.VALIDATION_ERROR

    def test_disabled_participant_rejected(self, seeded_db):
        customer = _customer(seeded_db)
        seeded_db.commit()
        set_customer_status(seeded_db, customer.id, "DISABLED", actor="pytest")
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            create_order(
                seeded_db,
                order_type="HS",
                trade_date=TODAY,
                actor="pytest",
                customer_roles=[(customer.id, "SELLER")],
            )
        assert exc.value.code == ErrorCode.CUSTOMER_DISABLED

class TestOrdersApi:
    def test_invalid_money_input_returns_business_422(self, seeded_client, seeded_db, headers):
        account = create_account(
            seeded_db,
            game_account="api-invalid-money",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        )
        created = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": TODAY.isoformat(),
                "account_id": account.id,
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

    def test_create_order_and_post_event(self, seeded_client, seeded_db, headers):
        account = create_account(
            seeded_db,
            game_account="api-sale-account",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        )
        created = seeded_client.post(
            "/api/v1/orders",
            json={
                "order_type": "HS",
                "trade_date": TODAY.isoformat(),
                "account_id": account.id,
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
                "bound_phone": "13900000000",
                "bound_phone_owner": "李四",
                "operator_user_ids": [1],
            },
            headers=headers,
        )
        assert event.status_code == 201
        body = event.json()
        assert body["cashflow_no"] == "SR00001"
        assert body["event"]["event_type"] == "SELL"
        assert body["event"]["reason"] == "买家确认收款"
        assert body["event"]["note"] == "售出动作备注"
        assert body["event"]["form_extra"] == {
            "sale_mode": "FULL",
            "bound_phone": "13900000000",
            "bound_phone_owner": "李四",
        }
        assert body["event"]["offset_event_id"] is None
        assert body["event"]["created_at"]
        assert body["event"]["posted_at"]
        assert seeded_db.get(OrderEvent, body["event"]["id"]).operator_user_ids == [1]

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


# 订单参与方与订单事件生命周期

def _account(seeded_db, *, game_account: str = "b4-acc", status: str = "WAITING") -> Account:
    acc = Account(
        game_account=game_account,
        platform="王者",
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

def test_add_customer_role_rejects_role_outside_order_type_whitelist(seeded_db):
    """TH 订单仅允许 BUYER，追挂 SELLER 必须被白名单拦截（原实现三元组去重放行）。"""
    th = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest")
    cust = create_customer(seeded_db, display_name="追挂甲", actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="不允许客户角色"):
        add_customer_role(seeded_db, th.id, cust.id, "SELLER", actor="pytest")

def test_add_customer_role_rejects_invalid_role(seeded_db):
    order = _hs_order(seeded_db)
    cust = create_customer(seeded_db, display_name="追挂乙", actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="客户角色必须为"):
        add_customer_role(seeded_db, order.id, cust.id, "NOT_A_ROLE", actor="pytest")

def test_add_customer_role_rejects_disabled_customer(seeded_db):
    """停用客户不得作为新订单参与方（原实现缺 assert_customer_usable）。"""
    order = _hs_order(seeded_db)
    cust = create_customer(seeded_db, display_name="停用买家", actor="pytest")
    set_customer_status(seeded_db, cust.id, "DISABLED", actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="不可作为新订单参与方"):
        add_customer_role(seeded_db, order.id, cust.id, "BUYER", actor="pytest")

def test_add_customer_role_allows_valid_buyer(seeded_db):
    order = _hs_order(seeded_db)
    cust = create_customer(seeded_db, display_name="正常买家", actor="pytest")
    seeded_db.commit()
    result = add_customer_role(seeded_db, order.id, cust.id, "BUYER", actor="pytest")
    row = seeded_db.scalar(
        select(OrderCustomerRole).where(
            OrderCustomerRole.order_id == order.id,
            OrderCustomerRole.customer_id == cust.id,
            OrderCustomerRole.role == "BUYER",
        )
    )
    assert result.id == order.id
    assert row is not None

def test_deliver_sell_rejects_void_account(seeded_db):
    """DELIVER 不得把 VOID 终态账号直接改回 SOLD（复活）。"""
    acc = _account(seeded_db, game_account="b4-void", status="WAITING")
    order = _hs_order(seeded_db, account=acc)
    seeded_db.commit()
    _buy(seeded_db, order)
    seeded_db.commit()
    # 先登记 SELL（账号 WAITING→SOLD），随后账号因其它原因作废。
    _sell(seeded_db, order)
    acc.status = "VOID"
    seeded_db.commit()
    with pytest.raises(Validation, match="已作废"):
        post_event(
            seeded_db, order.id, event_type="DELIVER", occurred_on=TODAY2,
            actor="pytest", delivery_mode="PLATFORM_OPERATOR", note="换绑凭证",
        )

def test_deliver_sell_uses_state_machine_for_non_sold_account(seeded_db):
    """异常数据（SELL 已登记但账号仍 WAITING）交付时必须走状态机收敛到 SOLD。"""
    acc = _account(seeded_db, game_account="b4-wait", status="WAITING")
    order = _hs_order(seeded_db, account=acc)
    seeded_db.commit()
    _buy(seeded_db, order)
    _sell(seeded_db, order)
    # 模拟账号状态未随 SELL 同步的异常数据。
    acc.status = "WAITING"
    seeded_db.commit()
    post_event(
        seeded_db, order.id, event_type="DELIVER", occurred_on=TODAY2,
        actor="pytest", delivery_mode="PLATFORM_OPERATOR", note="换绑凭证",
    )
    seeded_db.refresh(acc)
    assert acc.status == "SOLD"

def test_reopen_buy_allows_second_sell_closed_loop(seeded_db):
    """COMPLETED → 重开 BUY → ACTIVE → 再次 SELL 必须闭环，不再被「一次 SELL」卡死。"""
    acc = _account(seeded_db, game_account="b4-reopen")
    order = _hs_order(seeded_db, account=acc)
    seeded_db.commit()
    _buy(seeded_db, order, occurred=TODAY)
    _sell(seeded_db, order, occurred=TODAY2)
    seeded_db.refresh(order)
    assert order.status == "COMPLETED"

    # 重开 BUY：COMPLETED → ACTIVE，账号 SOLD → WAITING。
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("450"),
        occurred_on=date(2026, 10, 20), actor="pytest",
    )
    seeded_db.refresh(order)
    seeded_db.refresh(acc)
    assert order.status == "ACTIVE"
    assert acc.status == "WAITING"

    # 再次 SELL：应放行并回到 COMPLETED。
    post_event(
        seeded_db, order.id, event_type="SELL", amount=Decimal("700"),
        occurred_on=date(2026, 10, 22), actor="pytest", portion="PROFIT",
    )
    seeded_db.refresh(order)
    seeded_db.refresh(acc)
    assert order.status == "COMPLETED"
    assert acc.status == "SOLD"
    sells = seeded_db.scalars(
        select(OrderEvent).where(
            OrderEvent.order_id == order.id,
            OrderEvent.event_type == "SELL", OrderEvent.is_posted.is_(True),
        )
    ).all()
    assert len(sells) == 2

def test_second_sell_without_reopen_buy_still_rejected(seeded_db):
    """订单异常回到 ACTIVE、但没有新增 BUY 时，重复 SELL 仍须被拦截。"""
    acc = _account(seeded_db, game_account="b4-dupsell")
    order = _hs_order(seeded_db, account=acc)
    seeded_db.commit()
    _buy(seeded_db, order, occurred=TODAY)
    _sell(seeded_db, order, occurred=TODAY2)
    # 手动把订单拉回 ACTIVE（不带新的 BUY 事件），模拟异常态。
    order.status = "ACTIVE"
    acc.status = "WAITING"
    seeded_db.commit()
    with pytest.raises(Validation, match="重开 BUY"):
        post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("700"),
            occurred_on=date(2026, 10, 22), actor="pytest", portion="PROFIT",
        )
