"""API-01 SYS-01-03 订单详情附件契约测试。"""
from __future__ import annotations

import base64
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import delete, select, text

from app.business.orders.create import create_order
from app.domain.attachments import Attachment
from app.domain.foundation import AuditLog, DocumentSequence
from app.domain.options import OptionSet


@pytest.fixture(autouse=True)
def isolate_attachment_files(monkeypatch, tmp_path):
    from app.settings.attachments import service

    monkeypatch.setattr(service, "get_settings", lambda: type("Settings", (), {"attachment_storage_path": tmp_path})())


def test_new_database_does_not_initialize_attachment_numbering(seeded_db):
    from app.settings.field_definitions.catalog_seed import seed_catalog

    assert seeded_db.scalar(select(DocumentSequence).where(DocumentSequence.sequence_key == "ATTACHMENT")) is None
    seed_catalog(seeded_db, actor="pytest")
    dictionary = seeded_db.scalar(select(OptionSet).where(OptionSet.code == "SEQUENCE_KEY"))
    assert dictionary is not None
    assert "ATTACHMENT" not in {item["value"] for item in dictionary.options}
    dictionary.options = [*dictionary.options, {"value": "ATTACHMENT", "label": "附件"}, {"value": "ORDER_CUSTOM", "label": "自定义"}]
    seeded_db.flush()
    seed_catalog(seeded_db, actor="pytest")
    assert "ATTACHMENT" not in {item["value"] for item in dictionary.options}
    assert {"value": "ORDER_CUSTOM", "label": "自定义"} in dictionary.options


def test_sequences_hide_retired_attachment_counter_but_keep_other_domains(seeded_client, seeded_db, headers):
    seeded_db.add_all([
        DocumentSequence(sequence_key="ATTACHMENT", prefix="ATT", padding=4, current_value=7),
        DocumentSequence(sequence_key="OTHER_ACTIVE", prefix="EX", padding=4, current_value=2),
    ])
    seeded_db.commit()
    response = seeded_client.get("/api/sequences", headers=headers)
    assert response.status_code == 200, response.text
    keys = {item["sequence_key"] for item in response.json()}
    assert "ATTACHMENT" not in keys
    assert "OTHER_ACTIVE" in keys
    assert seeded_db.scalar(select(DocumentSequence).where(DocumentSequence.sequence_key == "ATTACHMENT")) is not None


def test_order_attachment_can_be_uploaded_listed_downloaded_and_deleted(
    seeded_client, seeded_db, headers
):
    order = create_order(
        seeded_db, order_type="HS", trade_date=date(2026, 10, 17), actor="pytest"
    )
    seeded_db.execute(delete(DocumentSequence).where(DocumentSequence.sequence_key == "ATTACHMENT"))
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
    assert "attachment_no" not in item
    assert seeded_db.get(Attachment, item["id"]).attachment_no is None
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
    assert order_detail.json()["attachments"][0]["id"] == item["id"]

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

    audits = seeded_db.scalars(select(AuditLog).where(
        AuditLog.action.in_(["ATTACHMENT_UPLOAD", "ATTACHMENT_DELETE"]),
        AuditLog.entity_type == "order", AuditLog.entity_id == order.order_no,
    )).all()
    assert {audit.action for audit in audits} == {"ATTACHMENT_UPLOAD", "ATTACHMENT_DELETE"}
    assert all(audit.after_json["attachment_id"] == item["id"] for audit in audits)

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
    assert confirmed.json()["id"] != first.json()["id"]
    assert len(list(tmp_path.iterdir())) == 2


def test_legacy_attachment_remains_available_without_exposing_its_old_number(seeded_client, seeded_db, headers, tmp_path):
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 17), actor="pytest")
    (tmp_path / "old-file").write_bytes(b"legacy")
    old = Attachment(attachment_no="ATT0099", entity_type="order", entity_id=order.order_no,
        file_name="legacy.txt", storage_key="old-file", content_type="text/plain", size_bytes=6,
        sha256="a" * 64, created_by="pytest", updated_by="pytest")
    seeded_db.add(old)
    seeded_db.commit()

    listed = seeded_client.get("/api/attachments", params={"entity_type": "order", "entity_id": order.order_no}, headers=headers)
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"][0]["id"] == old.id
    assert "attachment_no" not in listed.json()["items"][0]
    downloaded = seeded_client.get(f"/api/attachments/{old.id}/download", headers=headers)
    assert downloaded.status_code == 200 and downloaded.content == b"legacy"
    assert seeded_db.get(Attachment, old.id).attachment_no == "ATT0099"


def test_existing_attachment_number_constraint_can_be_relaxed_without_losing_history(seeded_db):
    from scripts.relax_attachment_number import relax_attachment_number

    old = Attachment(attachment_no="ATT0001", entity_type="order", entity_id="HS0001",
        file_name="old.txt", storage_key="old", content_type="text/plain", size_bytes=1,
        sha256="a" * 64, created_by="pytest", updated_by="pytest")
    seeded_db.add(old)
    seeded_db.flush()
    seeded_db.execute(text("ALTER TABLE public.attachments ALTER COLUMN attachment_no SET NOT NULL"))

    assert relax_attachment_number(seeded_db.connection()) is True
    assert relax_attachment_number(seeded_db.connection()) is False
    new = Attachment(entity_type="order", entity_id="HS0001", file_name="new.txt",
        storage_key="new", content_type="text/plain", size_bytes=1, sha256="b" * 64,
        created_by="pytest", updated_by="pytest")
    seeded_db.add(new)
    seeded_db.flush()
    assert old.attachment_no == "ATT0001"
    assert new.attachment_no is None
