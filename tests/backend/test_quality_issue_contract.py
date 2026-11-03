"""QUALITY-01 QLT-01-05 异常工单契约测试。"""
from __future__ import annotations


def test_quality_issue_can_be_created_updated_and_closed(
    seeded_client, seeded_db, headers
):
    created = seeded_client.post(
        "/api/v1/quality/issues",
        json={
            "code": "EVENT_CASHFLOW_MISMATCH",
            "severity": "CRITICAL",
            "title": "事件与现金流不一致",
            "entity_type": "order_event",
            "entity_id": "HS0001-EV-BUY-01",
            "message": "测试异常",
            "details": {"cashflow_count": 0},
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    issue = created.json()
    assert issue["issue_no"].startswith("QI")
    assert issue["status"] == "OPEN"

    duplicate = seeded_client.post(
        "/api/v1/quality/issues",
        json={
            "code": "EVENT_CASHFLOW_MISMATCH",
            "severity": "CRITICAL",
            "title": "事件与现金流不一致",
            "entity_type": "order_event",
            "entity_id": "HS0001-EV-BUY-01",
            "message": "重复异常",
        },
        headers=headers,
    )
    assert duplicate.status_code == 409, duplicate.text

    updated = seeded_client.patch(
        f"/api/v1/quality/issues/{issue['id']}",
        json={"status": "IN_PROGRESS"},
        headers=headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["status"] == "IN_PROGRESS"

    removed_field = seeded_client.patch(
        f"/api/v1/quality/issues/{issue['id']}",
        json={"assignee_id": 2},
        headers=headers,
    )
    assert removed_field.status_code == 422, removed_field.text

    closed = seeded_client.post(
        f"/api/v1/quality/issues/{issue['id']}/close",
        json={"resolution": "补齐来源流水", "evidence": "人工核对单号 CF0001"},
        headers=headers,
    )
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "CLOSED"
    assert closed.json()["closed_by"] == "admin"


def test_quality_issue_list_and_closed_filter(seeded_client, headers):
    created = seeded_client.post(
        "/api/v1/quality/issues",
        json={
            "code": "ORPHAN_CASHFLOW",
            "severity": "HIGH",
            "title": "孤儿流水",
            "entity_type": "cashflow",
            "entity_id": "CF0002",
            "message": "测试异常",
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    listed = seeded_client.get(
        "/api/v1/quality/issues", params={"status": "OPEN"}, headers=headers
    )
    assert listed.status_code == 200, listed.text
    assert listed.json()["total"] == 1


def test_get_quality_issue_endpoint(seeded_client, headers):
    created = seeded_client.post(
        "/api/v1/quality/issues",
        json={
            "code": "GET_API_CODE",
            "severity": "MEDIUM",
            "title": "查询接口工单",
            "entity_type": "order",
            "entity_id": "GET-API-1",
            "message": "测试",
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    issue_id = created.json()["id"]
    response = seeded_client.get(f"/api/v1/quality/issues/{issue_id}", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["issue_no"] == created.json()["issue_no"]
