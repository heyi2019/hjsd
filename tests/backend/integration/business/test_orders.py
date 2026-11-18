"""ORDER-01 tests/backend/test_orders：订单、事件、现金流派生（A01 / A02 / A03）。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.stocks.profile import create_account
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.domain.enums import AccountStatus, Direction, EventType, OrderStatus
from app.domain.foundation import Pool
from app.field_definitions.order_types import get_order_type_by_code
from app.domain.parties import OrderCustomerRole
from app.domain.trade import Account, Cashflow, Installment, Order, OrderEvent
from app.installments import create as inst_create
from app.installments import recovery as inst_recovery
from app.installments.repayments.pay import pay as inst_pay
from app.orders.create import add_customer_role, create_order
from app.orders.events import post_event
from app.customer_center.counterparties import create_counterparty
from app.customer_center.customers import create_customer, set_customer_status

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
