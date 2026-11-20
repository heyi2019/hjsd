"""API-01 orders 顶层集成契约：建单/工作台/事件/DB 约束（ORD-01/02、FIN-01/03）。

按 class 拆分后的保留文件：仅含模块级 test 函数与共享 helper。
其余 class 分别在 test_orders_create_validation / query_contract /
account_effects / api 四个文件。
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from app.core.errors import Validation
from app.core.security import CurrentUser
from app.domain.enums import (
    OrderStatus)
from app.business.stocks.profile import create_account
from app.domain.trade import Account, Cashflow, Order, OrderEvent, OrderFormField
from app.business import schemas
from app.business.create import create_order
from app.business.events import post_event
from app.business.router_output import _order_list_payload

D = date(2026, 10, 4)

def _order(
    seeded_db,
    *,
    order_type="HS",
    account_id=None,
    owner_id=None,
    trade_date=D,
    form_extra=None,
):
    if order_type == "HS" and account_id is None:
        account_id = create_account(
            seeded_db,
            game_account=f"orders-contract-{uuid4().hex[:10]}",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        ).id
    return create_order(
        seeded_db, order_type=order_type, trade_date=trade_date, actor="pytest",
        account_id=account_id, owner_id=owner_id,
        form_extra=form_extra,
    )

def _scoped_user() -> CurrentUser:
    """非 admin、SELF 作用域用户（可见集只有自己）。"""
    return CurrentUser.build(
        id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
    )


def test_order_create_uses_account_snapshot_as_the_only_account_input():
    with pytest.raises(ValidationError, match="extra_forbidden"):
        schemas.OrderCreate(
            order_type="HS",
            trade_date=D,
            game_account="legacy-flat-account",
        )


def test_workbench_summary_exposes_one_backend_aggregate(seeded_client, headers):
    response = seeded_client.get("/api/v1/dashboard/summary", headers=headers)

    assert response.status_code == 200, response.text
    payload = response.json()
    assert set(payload) == {
        "period",
        "orders",
        "personal_orders",
        "personal_customers",
        "personal_earnings",
        "inventory",
        "installments",
        "alerts",
    }
    assert set(payload["period"]) == {"from", "to"}
    assert isinstance(payload["alerts"], list)
    assert set(payload["orders"]) == {"total_count"}
    assert seeded_client.get("/api/v1/stocks/dashboard-summary", headers=headers).status_code in {404, 405}
    assert seeded_client.get("/api/v1/notifications/summary", headers=headers).status_code in {404, 405}


def test_workbench_alerts_follow_backend_thresholds_and_switches(seeded_client, headers, monkeypatch):
    from app.dashboard import service as dashboard_service

    settings = {"inventory_aging_days": 14, "profit_notifications_enabled": True, "overdue_installments_enabled": False}
    monkeypatch.setattr(dashboard_service, "_reminder_config", lambda db: settings)
    monkeypatch.setattr(dashboard_service, "dashboard_inventory_summary", lambda *args, **kwargs: {"account_count": 2, "aging_count": 2, "overdue_count": 0})
    monkeypatch.setattr(dashboard_service.installment_queries, "installment_totals", lambda *args, **kwargs: {"total_count": 3, "overdue_count": 3})
    monkeypatch.setattr(dashboard_service.notification_service, "unread_profit_counts", lambda *args, **kwargs: {"pending_profit_count": 1, "allocated_profit_count": 2})

    response = seeded_client.get("/api/v1/dashboard/summary", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["alerts"] == [
        {"type": "inventory_aging", "message": "库存订单入库超过 14 天 2 个"},
        {"type": "pending_profit", "message": "分润待配置 1 条"},
        {"type": "allocated_profit", "message": "获得分润通知 2 条"},
    ]
    settings["profit_notifications_enabled"] = False
    settings["overdue_installments_enabled"] = True
    response = seeded_client.get("/api/v1/dashboard/summary", headers=headers)
    assert response.json()["alerts"] == [
        {"type": "inventory_aging", "message": "库存订单入库超过 14 天 2 个"},
        {"type": "overdue_installment", "message": "逾期合约 3 个"},
    ]


def test_workbench_personal_earnings_uses_commission_profit_base(
    seeded_client, headers, monkeypatch
):
    monkeypatch.setattr(
        "app.dashboard.service.personal_commission_total",
        lambda *args, **kwargs: Decimal("123.45"),
    )

    response = seeded_client.get("/api/v1/dashboard/summary", headers=headers)

    assert response.status_code == 200, response.text
    assert response.json()["personal_earnings"] == "123.45"


def test_workbench_order_cards_use_the_current_period(seeded_client, seeded_db, headers, monkeypatch):
    calls = []
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 11, 20)

    monkeypatch.setattr("app.dashboard.service.date", FixedDate)

    def fake_order_status_counts(session, **kwargs):
        calls.append(kwargs)
        return {"COMPLETED": 1}

    monkeypatch.setattr("app.dashboard.service.order_status_counts", fake_order_status_counts)

    response = seeded_client.get("/api/v1/dashboard/summary", headers=headers)

    assert response.status_code == 200, response.text
    assert len(calls) == 2
    expected = {"trade_date_from": date(2026, 11, 16), "trade_date_to": date(2026, 12, 15)}
    assert calls[0]["trade_date_from"] == expected["trade_date_from"]
    assert calls[0]["trade_date_to"] == expected["trade_date_to"]
    assert calls[0].get("mine", False) is False
    assert calls[1]["trade_date_from"] == expected["trade_date_from"]
    assert calls[1]["trade_date_to"] == expected["trade_date_to"]
    assert calls[1]["mine"] is True
    calls.clear()
    response = seeded_client.get("/api/v1/dashboard/summary", headers=headers, params={"from": "2026-01-02", "to": "2026-02-04"})
    assert response.status_code == 200, response.text
    assert response.json()["period"] == {"from": "2026-01-02", "to": "2026-02-04"}
    assert all(call["trade_date_from"] == date(2026, 1, 2) and call["trade_date_to"] == date(2026, 2, 4) for call in calls)
    assert seeded_client.get("/api/v1/dashboard/summary", headers=headers, params={"from": "2026-02-04", "to": "2026-01-02"}).status_code == 422
    assert seeded_client.get("/api/v1/dashboard/summary", headers=headers, params={"from": "2026-01-02"}).status_code == 422
    calls.clear()
    response = seeded_client.get("/api/v1/dashboard/summary", headers=headers, params={"all_time": "true"})
    assert response.status_code == 200, response.text
    assert response.json()["period"] is None
    assert all(call["trade_date_from"] is None and call["trade_date_to"] is None for call in calls)
    assert seeded_client.get("/api/v1/dashboard/summary", headers=headers, params={"all_time": "true", "from": "2026-01-02", "to": "2026-02-04"}).status_code == 422
    from app.domain.options import OptionSet
    setting = OptionSet(code="BUSINESS_PERIOD", label="当期设置", group="BUSINESS", editable=False, options=[{"value": "start_day", "label": "10"}], created_by="pytest", updated_by="pytest")
    seeded_db.add(setting)
    seeded_db.flush()
    response = seeded_client.get("/api/v1/dashboard/summary", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["period"] == {"from": "2026-11-10", "to": "2026-12-09"}
    from app.shared.business_period import business_period
    assert business_period(date(2028, 2, 28), 31) == (date(2028, 1, 31), date(2028, 2, 28))
    assert business_period(date(2028, 2, 29), 31) == (date(2028, 2, 29), date(2028, 3, 30))

def test_order_create_validates_active_custom_field_values(seeded_db):
    field = OrderFormField(
        order_type_code="HS",
        field_key="idcard_check",
        label="身份证",
        field_type="NUMBER",
        required=True,
        is_active=True,
        is_custom=True,
        section="ACCOUNT_PRODUCT",
        sort_order=1000,
    )
    seeded_db.add(field)
    seeded_db.flush()

    with pytest.raises(Validation, match="必须为数字"):
        create_order(
            seeded_db,
            order_type="HS",
            trade_date=D,
            actor="pytest",
            account_snapshot={"game_account": "invalid-extra-account"},
            form_extra={"idcard_check": "not-a-number"},
        )

def test_account_product_custom_values_follow_inline_inventory_account(seeded_db):
    field = OrderFormField(
        order_type_code="HS",
        field_key="idcard_store",
        label="身份证",
        field_type="TEXT",
        required=False,
        is_active=True,
        is_custom=True,
        section="ACCOUNT_PRODUCT",
        sort_order=1001,
    )
    seeded_db.add(field)
    seeded_db.flush()

    order = create_order(
        seeded_db,
        order_type="HS",
        trade_date=D,
        actor="pytest",
        account_snapshot={
            "game_account": "account-extra-store",
            "extra_values": {"idcard_store": "123456"},
        },
        form_extra={"idcard_store": "123456"},
    )

    account = seeded_db.get(Account, order.account_id)
    assert account is not None
    assert account.form_extra == {"idcard_store": "123456"}
    assert order.form_extra is None

@pytest.mark.parametrize(("order_type", "inventory_type"), [("HS", "RECOVERY"), ("TH", "PICKUP"), ("DG", "CONSIGNMENT")])
def test_inline_order_creates_inventory_in_one_request(seeded_client, seeded_db, headers, order_type, inventory_type):
    payload = {
        "order_type": order_type, "trade_date": D.isoformat(),
        "account_snapshot": {"game_account": f"inline-api-{order_type}"},
    }
    if order_type != "DG":
        payload["initial_buy"] = {"amount": "100", "occurred_on": D.isoformat()}
        payload["initial_costs"] = [{"amount": "10", "occurred_on": D.isoformat(), "flow_category": "FEE"}]
    response = seeded_client.post("/api/v1/orders", json=payload, headers=headers)
    assert response.status_code == 201, response.text
    account = seeded_db.get(Account, response.json()["account_id"])
    assert account is not None
    assert account.inventory_type == inventory_type
    assert account.cost_amount == Decimal("110.00" if order_type != "DG" else "0.00")

    if order_type != "DG":
        order_id = response.json()["id"]
        assert not seeded_db.scalars(
            select(OrderEvent).where(
                OrderEvent.order_id == order_id,
                OrderEvent.event_type == "COST",
            )
        ).first()
        expense = seeded_db.scalars(
            select(Cashflow).where(
                Cashflow.order_id == order_id,
                Cashflow.category == "FEE",
            )
        ).first()
        assert expense is not None
        assert expense.direction == "OUT"
        assert expense.accounting_attribute in {"SELF_DIRECT_COST", "TH_DIRECT_COST"}
        list_row = _order_list_payload(seeded_db, [seeded_db.get(Order, order_id)])[0]
        assert list_row["cost_amount"] == Decimal("110.00")

def test_order_success_time_is_inventory_entry_time(seeded_db):
    account = create_account(
        seeded_db,
        game_account="inventory-entry-from-order",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    account.inventory_entry_at = datetime(2026, 1, 1, 8, 0)
    seeded_db.flush()

    order = create_order(
        seeded_db,
        order_type="HS",
        trade_date=D,
        actor="pytest",
        account_id=account.id,
    )

    assert account.inventory_entry_at == order.created_at.replace(microsecond=0)


def test_order_list_payload_includes_inventory_and_sale_responsibility_timestamps(seeded_db):
    order = _order(seeded_db)
    account = seeded_db.get(Account, order.account_id)
    assert account is not None
    account.inventory_entry_at = datetime(2026, 10, 1, 9, 30, 0)
    account.created_by = "inventory-user"
    seeded_db.flush()

    post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount="100.00",
        occurred_on=D,
        actor="inventory-user",
        pool_id=1,
    )
    sale, _ = post_event(
        seeded_db,
        order.id,
        event_type="SELL",
        amount="150.00",
        occurred_on=D,
        actor="sale-user",
        pool_id=2,
    )
    sale.created_at = datetime(2026, 10, 17, 16, 45, 0)
    seeded_db.flush()

    row = _order_list_payload(seeded_db, [order])[0]

    assert row["inventory_entry_at"] == datetime(2026, 10, 1, 9, 30, 0)
    assert row["inventory_operator"] is None
    # 售卖时间取卖出事件的业务发生日 D，与 created_at 无关（created_at 是写入时刻）。
    assert row["sale_at"] == datetime(2026, 10, 4, 0, 0, 0)
    assert row["sale_operator"] is None

def test_failed_initial_cost_rolls_back_order_and_inventory(app, seeded_db, v1_engine, headers, monkeypatch):
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import sessionmaker
    from app.core import database

    monkeypatch.setattr(database, "get_session_factory", lambda: sessionmaker(bind=v1_engine))
    with TestClient(app) as client:
        response = client.post("/api/v1/orders", headers=headers, json={
            "order_type": "HS", "trade_date": D.isoformat(),
            "account_snapshot": {"game_account": "rollback-inline"},
            "initial_buy": {"amount": "100", "occurred_on": D.isoformat()},
            "initial_costs": [{"amount": "0", "occurred_on": D.isoformat()}],
        })
    assert response.status_code == 422, response.text
    assert seeded_db.scalar(select(Account).where(Account.game_account == "rollback-inline")) is None
    assert seeded_db.scalar(
        select(Order).where(
            # 跨方言 JSON 取值：func.json_extract 是 SQLite 专有函数，PG 无此函数。
            Order.account_snapshot["game_account"].as_string() == "rollback-inline"
        )
    ) is None


def test_database_allows_inventory_links_for_th_orders(seeded_db):
    account = create_account(
        seeded_db,
        game_account="th-inventory-link",
        business_mode="DISTRIBUTION",
        inventory_type="PICKUP",
        actor="pytest",
    )
    order = _order(seeded_db, order_type="TH", account_id=account.id)

    seeded_db.flush()
    assert order.account_id == account.id
    assert order.account_snapshot is None

def test_database_accepts_th_order_snapshot_and_rejects_custom_type(seeded_db):
    """2026-10-28 口径：快照 CHECK 放宽为四类业务通用，自定义类型仍被库层拒绝。"""
    order = _order(seeded_db, order_type="TH")
    order.account_snapshot = {"game_account": "th-text-only"}
    seeded_db.flush()
    assert order.account_snapshot == {"game_account": "th-text-only"}
    seeded_db.rollback()

    custom = Order(order_no=f"XX{uuid4().hex[:8]}", order_type="XX", trade_date=D)
    custom.account_snapshot = {"game_account": "custom-text"}
    seeded_db.add(custom)
    with pytest.raises(IntegrityError):
        seeded_db.flush()
    seeded_db.rollback()

@pytest.mark.parametrize("order_type", ["HS", "TH", "DG"])
def test_sell_completes_non_installment_orders(seeded_db, order_type):
    inventory_context = {
        "HS": ("SELF", "RECOVERY"),
        "TH": ("DISTRIBUTION", "PICKUP"),
        "DG": ("DISTRIBUTION", "CONSIGNMENT"),
    }[order_type]
    account = create_account(
        seeded_db,
        game_account=f"sell-completes-{order_type.lower()}-{uuid4().hex[:10]}",
        business_mode=inventory_context[0],
        inventory_type=inventory_context[1],
        actor="pytest",
    )
    order = _order(seeded_db, order_type=order_type, account_id=account.id)

    if order_type in {"HS", "TH"}:
        post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount=Decimal("100"),
            occurred_on=D,
            actor="pytest",
            pool_id=1,
        )

    post_event(
        seeded_db,
        order.id,
        event_type="SELL",
        amount=Decimal("150"),
        occurred_on=D,
        actor="pytest",
        pool_id=2,
    )

    assert order.status == OrderStatus.COMPLETED.value


