"""SYS-01-03 附件中心契约测试。"""
from __future__ import annotations

import base64
from datetime import date

from app.orders import service as order_service


def test_order_attachment_can_be_uploaded_listed_downloaded_and_deleted(
    seeded_client, seeded_db, headers
):
    order = order_service.create_order(
        seeded_db, order_type="HS", trade_date=date(2026, 10, 17), actor="pytest"
    )
    seeded_db.commit()

    created = seeded_client.post(
        "/api/v1/attachments",
        json={
            "entity_type": "order",
            "entity_id": order.order_no,
            "file_name": "回收凭证.png",
            "content_type": "image/png",
            "content_base64": base64.b64encode(b"png-test").decode(),
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    item = created.json()
    assert item["attachment_no"].startswith("ATT")
    assert item["entity_id"] == order.order_no
    assert item["size_bytes"] == 8
    assert item["deleted_at"] is None

    listed = seeded_client.get(
        "/api/v1/attachments",
        params={"entity_type": "order", "entity_id": order.order_no},
        headers=headers,
    )
    assert listed.status_code == 200, listed.text
    assert listed.json()["total"] == 1

    downloaded = seeded_client.get(
        f"/api/v1/attachments/{item['id']}/download", headers=headers
    )
    assert downloaded.status_code == 200, downloaded.text
    assert downloaded.content == b"png-test"
    assert downloaded.headers["content-type"] == "image/png"

    deleted = seeded_client.delete(
        f"/api/v1/attachments/{item['id']}", headers=headers
    )
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["deleted_at"] is not None

    listed_after_delete = seeded_client.get(
        "/api/v1/attachments",
        params={"entity_type": "order", "entity_id": order.order_no},
        headers=headers,
    )
    assert listed_after_delete.json()["total"] == 0


def test_attachment_requires_existing_entity_and_read_permission(
    seeded_client, headers, viewer_headers
):
    missing = seeded_client.post(
        "/api/v1/attachments",
        json={
            "entity_type": "order",
            "entity_id": "HS9999",
            "file_name": "x.txt",
            "content_type": "text/plain",
            "content_base64": base64.b64encode(b"x").decode(),
        },
        headers=headers,
    )
    assert missing.status_code == 404, missing.text

    no_auth = seeded_client.get(
        "/api/v1/attachments",
        params={"entity_type": "order", "entity_id": "HS9999"},
    )
    assert no_auth.status_code == 401, no_auth.text

    issue = seeded_client.post(
        "/api/v1/quality/issues",
        json={
            "code": "TEST_ATTACHMENT_PERMISSION",
            "severity": "LOW",
            "title": "附件权限测试",
            "entity_type": "order",
            "entity_id": "HS9999",
            "message": "测试附件权限",
        },
        headers=headers,
    )
    assert issue.status_code == 201, issue.text

    viewer_upload = seeded_client.post(
        "/api/v1/attachments",
        json={
            "entity_type": "quality_issue",
            "entity_id": issue.json()["issue_no"],
            "file_name": "x.txt",
            "content_type": "text/plain",
            "content_base64": base64.b64encode(b"x").decode(),
        },
        headers=viewer_headers,
    )
    assert viewer_upload.status_code == 403, viewer_upload.text
