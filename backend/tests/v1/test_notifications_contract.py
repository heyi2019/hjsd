"""SYS-01-04 系统通知契约测试。"""
from __future__ import annotations


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
