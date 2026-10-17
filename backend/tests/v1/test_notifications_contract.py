"""SYS-01-04 系统通知契约测试。"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from app.accounts import service as account_service
from app.finance import service as finance_service
from app.orders import service as order_service


D = date(2026, 10, 17)


def test_quality_assignment_creates_notification_and_can_be_read(
    seeded_client, headers
):
    created = seeded_client.post(
        "/api/v1/quality/issues",
        headers=headers,
        json={
            "code": "EVENT_POOL_MISSING",
            "severity": "HIGH",
            "title": "事件缺少资金池",
            "entity_type": "order_event",
            "entity_id": "EVT0001",
            "message": "需要补充资金池。",
            "assignee_id": 2,
        },
    )
    assert created.status_code == 201, created.text
    issue = created.json()

    notifications = seeded_client.get(
        "/api/v1/notifications", headers={"X-Dev-User": "operator"}
    )
    assert notifications.status_code == 200, notifications.text
    body = notifications.json()
    assert body["total"] == 1
    assert body["unread_total"] == 1
    assert body["items"][0]["notification_no"] == "NTF0001"
    assert body["items"][0]["entity_id"] == issue["issue_no"]

    marked = seeded_client.post(
        f"/api/v1/notifications/{body['items'][0]['id']}/read",
        headers={"X-Dev-User": "operator"},
    )
    assert marked.status_code == 200, marked.text
    assert marked.json()["read_at"] is not None

    unread = seeded_client.get(
        "/api/v1/notifications?unread_only=true",
        headers={"X-Dev-User": "operator"},
    )
    assert unread.status_code == 200
    assert unread.json()["items"] == []
    assert unread.json()["unread_total"] == 0


def test_notifications_are_private_to_recipient(seeded_client, headers):
    created = seeded_client.post(
        "/api/v1/quality/issues",
        headers=headers,
        json={
            "code": "NEGATIVE_AVAILABLE",
            "severity": "HIGH",
            "title": "余额异常",
            "entity_type": "pool",
            "entity_id": "POOL01",
            "message": "需要核查。",
            "assignee_id": 2,
        },
    )
    assert created.status_code == 201
    issue_no = created.json()["issue_no"]
    admin_view = seeded_client.get("/api/v1/notifications", headers=headers)
    assert admin_view.status_code == 200
    assert admin_view.json()["items"] == []

    operator_view = seeded_client.get(
        "/api/v1/notifications", headers={"X-Dev-User": "operator"}
    )
    assert operator_view.json()["items"][0]["entity_id"] == issue_no


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
