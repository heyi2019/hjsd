"""SYS-01-04 系统通知契约测试。"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from app.stocks import service as account_service
from app.finance import service as finance_service
from app.orders import service as order_service


D = date(2026, 10, 17)


def test_notification_sync_route_publishes_typed_response_model(app):
    schema = app.openapi()["paths"]["/api/v1/notifications/sync-overdue-rebates"]["post"]["responses"]["200"]["content"]["application/json"]["schema"]
    assert schema["$ref"].endswith("/NotificationSyncOut")


def test_overdue_rebate_sync_notifies_order_owner_once(
    seeded_client, seeded_db, headers
):
    account = account_service.create_account(
        seeded_db,
        game_account="notification-rebate-account",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    order = order_service.create_order(
        seeded_db,
        order_type="HS",
        owner_id=2,
        trade_date=D,
        account_id=account.id,
        actor="pytest",
    )
    order_service.post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal("1000"),
        occurred_on=D,
        actor="pytest",
    )
    rebate = finance_service.create_rebate(
        seeded_db,
        source_order_id=order.id,
        rebate_type="BUY",
        base_amount=Decimal("1000"),
        collected_on=D,
        expected_on=D - timedelta(days=3),
        rate=Decimal("5"),
        actor="pytest",
    )

    first = seeded_client.post(
        "/api/v1/notifications/sync-overdue-rebates",
        params={"as_of": D.isoformat()},
        headers=headers,
    )
    assert first.status_code == 200, first.text
    assert first.json() == {"as_of": D.isoformat(), "created": 1, "existing": 0, "skipped": 0}

    operator_view = seeded_client.get(
        "/api/v1/notifications", headers={"X-Dev-User": "operator"}
    )
    assert operator_view.status_code == 200
    assert operator_view.json()["total"] == 1
    assert operator_view.json()["items"][0]["notification_type"] == "REBATE_OVERDUE"
    assert operator_view.json()["items"][0]["entity_id"] == rebate.rebate_no

    second = seeded_client.post(
        "/api/v1/notifications/sync-overdue-rebates",
        params={"as_of": D.isoformat()},
        headers=headers,
    )
    assert second.status_code == 200
    assert second.json() == {"as_of": D.isoformat(), "created": 0, "existing": 1, "skipped": 0}
