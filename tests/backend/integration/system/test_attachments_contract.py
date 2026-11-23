"""API-01 SYS-01-03 订单详情附件契约测试。"""
from __future__ import annotations

import base64
from datetime import date
from pathlib import Path

import pytest

from app.business.orders.create import create_order


@pytest.fixture(autouse=True)
def isolate_attachment_files(monkeypatch, tmp_path):
    from app.settings.attachments import service

    monkeypatch.setattr(service, "get_settings", lambda: type("Settings", (), {"attachment_storage_path": tmp_path})())


def test_order_attachment_can_be_uploaded_listed_downloaded_and_deleted(
    seeded_client, seeded_db, headers
):
    order = create_order(
        seeded_db, order_type="HS", trade_date=date(2026, 10, 17), actor="pytest"
    )
    seeded_db.commit()

    created = seeded_client.post(
        "/api/attachments",
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
        "/api/attachments",
        params={"entity_type": "order", "entity_id": order.order_no},
        headers=headers,
    )
    assert listed.status_code == 200, listed.text
    assert listed.json()["total"] == 1

    order_detail = seeded_client.get(
        f"/api/orders/{order.id}", headers=headers
    )
    assert order_detail.status_code == 200, order_detail.text
    assert order_detail.json()["attachments"][0]["attachment_no"] == item["attachment_no"]

    downloaded = seeded_client.get(
        f"/api/attachments/{item['id']}/download", headers=headers
    )
    assert downloaded.status_code == 200, downloaded.text
    assert downloaded.content == b"png-test"
    assert downloaded.headers["content-type"] == "image/png"

    deleted = seeded_client.delete(
        f"/api/attachments/{item['id']}", headers=headers
    )
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["deleted_at"] is not None

    listed_after_delete = seeded_client.get(
        "/api/attachments",
        params={"entity_type": "order", "entity_id": order.order_no},
        headers=headers,
    )
    assert listed_after_delete.json()["total"] == 0


def test_attachment_requires_existing_entity_and_read_permission(seeded_client, headers):
    missing = seeded_client.post(
        "/api/attachments",
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
        "/api/attachments",
        params={"entity_type": "order", "entity_id": "HS9999"},
    )
    assert no_auth.status_code == 401, no_auth.text


def test_duplicate_attachment_prompts_before_upload_and_can_continue(seeded_client, seeded_db, headers, monkeypatch, tmp_path):
    from app.settings.attachments import service

    monkeypatch.setattr(service, "get_settings", lambda: type("Settings", (), {"attachment_storage_path": Path(tmp_path)})())
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 17), actor="pytest")
    payload = {"entity_type": "order", "entity_id": order.order_no, "file_name": "receipt.txt",
        "content_type": "text/plain", "content_base64": base64.b64encode(b"same content").decode()}
    first = seeded_client.post("/api/attachments", json=payload, headers=headers)
    assert first.status_code == 201, first.text
    second = seeded_client.post("/api/attachments", json=payload, headers=headers)
    assert second.status_code == 409, second.text
    assert second.json()["code"] == "DUPLICATE_ATTACHMENT"
    assert len(list(tmp_path.iterdir())) == 1
    confirmed = seeded_client.post("/api/attachments", json={**payload, "allow_duplicate": True}, headers=headers)
    assert confirmed.status_code == 201, confirmed.text
    assert confirmed.json()["attachment_no"] != first.json()["attachment_no"]
    assert len(list(tmp_path.iterdir())) == 2
