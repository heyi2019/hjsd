"""tests/v1/test_parties：客户、合作方、活字段（CUS-01 / BAS-02-05 / BAS-04 / A10 / A11）。"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.core.errors import ErrorCode
from app.domain.enums import AuditAction, CustomerStatus
from app.domain.foundation import AuditLog
from app.domain.parties import Customer, OrderCustomerRole
from app.parties import service

CUSTOMERS = "/api/v1/customers"
COUNTERPARTIES = "/api/v1/counterparties"
FIELDS = "/api/v1/field-definitions"


class TestCustomerNumbering:
    def test_cus_number_allocated_independently(self, seeded_db):
        first = service.create_customer(seeded_db, display_name="阿甲", actor="pytest")
        second = service.create_customer(seeded_db, display_name="阿乙", actor="pytest")
        seeded_db.commit()
        assert first.customer_no == "CUS0001"
        assert second.customer_no == "CUS0002"

    def test_duplicate_contact_does_not_block(self, seeded_db):
        """联系方式允许重复：只返回候选，不拦截建档（CUS-01-05）。"""
        first = service.create_customer(seeded_db, display_name="甲", wechat="wx001", actor="pytest")
        seeded_db.commit()
        second = service.create_customer(seeded_db, display_name="乙", wechat="wx001", actor="pytest")
        candidates = service.duplicate_candidates(
            seeded_db, wechat="wx001", exclude_customer_id=second.id
        )
        seeded_db.commit()
        assert second.customer_no == "CUS0002"
        assert [item["customer_id"] for item in candidates] == [first.id]
        assert candidates[0]["matched_on"] == ["wechat"]


class TestMasking:
    def test_default_response_is_masked(self, seeded_db):
        customer = service.create_customer(
            seeded_db,
            display_name="甲",
            phone="13800001234",
            wechat="wxabc",
            qq="123456",
            actor="pytest",
        )
        seeded_db.commit()
        out = service.to_customer_out(customer, reveal_contact=False)
        assert out["contact_masked"] is True
        assert out["phone"] == "138****1234"
        assert out["wechat"].startswith("wx") and "*" in out["wechat"]
        assert "*" in out["qq"]

    def test_reveal_returns_full_contact(self, seeded_db):
        customer = service.create_customer(
            seeded_db, display_name="甲", phone="13800001234", actor="pytest"
        )
        seeded_db.commit()
        out = service.to_customer_out(customer, reveal_contact=True)
        assert out["contact_masked"] is False
        assert out["phone"] == "13800001234"


class TestCustomerUsability:
    def test_disabled_customer_rejected(self, seeded_db):
        customer = service.create_customer(seeded_db, display_name="甲", actor="pytest")
        seeded_db.commit()
        service.set_customer_status(seeded_db, customer.id, "DISABLED", actor="pytest")
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            service.assert_customer_usable(seeded_db, customer.id)
        assert exc.value.code == ErrorCode.CUSTOMER_DISABLED

    def test_merged_customer_rejected(self, seeded_db):
        source = service.create_customer(seeded_db, display_name="源", actor="pytest")
        target = service.create_customer(seeded_db, display_name="目标", actor="pytest")
        seeded_db.commit()
        service.merge_customers(
            seeded_db,
            source_customer_id=source.id,
            target_customer_id=target.id,
            reason="同一微信",
            actor="admin",
        )
        seeded_db.commit()
        assert source.status == CustomerStatus.MERGED.value
        with pytest.raises(Exception) as exc:
            service.assert_customer_usable(seeded_db, source.id)
        assert exc.value.code == ErrorCode.CUSTOMER_DISABLED


class TestMerge:
    def test_merge_moves_roles_and_keeps_history(self, seeded_db):
        source = service.create_customer(seeded_db, display_name="源", actor="pytest")
        target = service.create_customer(seeded_db, display_name="目标", actor="pytest")
        seeded_db.commit()
        seeded_db.add(OrderCustomerRole(order_id=1, customer_id=source.id, role="SELLER"))
        seeded_db.commit()

        service.merge_customers(
            seeded_db,
            source_customer_id=source.id,
            target_customer_id=target.id,
            reason="重复建档",
            actor="admin",
        )
        seeded_db.commit()

        migrated = seeded_db.scalars(
            select(OrderCustomerRole).where(OrderCustomerRole.customer_id == target.id)
        ).all()
        assert len(migrated) == 1
        assert migrated[0].order_id == 1
        assert source.customer_no == "CUS0001"
        assert source.merged_into_id == target.id
        assert seeded_db.get(Customer, source.id) is not None
        audit = seeded_db.scalars(
            select(AuditLog).where(AuditLog.action == AuditAction.CUSTOMER_MERGE.value)
        ).all()
        assert len(audit) == 1
        assert audit[0].reason == "重复建档"

    def test_merge_rejects_inactive_target(self, seeded_db):
        source = service.create_customer(seeded_db, display_name="源", actor="pytest")
        target = service.create_customer(seeded_db, display_name="目标", actor="pytest")
        seeded_db.commit()
        service.set_customer_status(seeded_db, target.id, "DISABLED", actor="pytest")
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            service.merge_customers(
                seeded_db,
                source_customer_id=source.id,
                target_customer_id=target.id,
                reason="x",
                actor="admin",
            )
        assert exc.value.code == ErrorCode.MERGE_TARGET_INVALID


class TestCounterparty:
    def test_cp_number_and_type_separation(self, seeded_db):
        peer = service.create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        supplier = service.create_counterparty(
            seeded_db, display_name="供货方B", type="SUPPLIER", actor="pytest"
        )
        seeded_db.commit()
        assert peer.counterparty_no == "CP0001"
        assert supplier.counterparty_no == "CP0002"
        assert seeded_db.scalar(select(Customer).where(Customer.display_name == "同行A")) is None

    def test_invalid_type_rejected(self, seeded_db):
        with pytest.raises(Exception) as exc:
            service.create_counterparty(
                seeded_db, display_name="X", type="CUSTOMER", actor="pytest"
            )
        assert exc.value.code == ErrorCode.VALIDATION_ERROR

    def test_disabled_counterparty_rejected(self, seeded_db):
        peer = service.create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        seeded_db.commit()
        service.set_counterparty_status(seeded_db, peer.id, False, actor="pytest")
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            service.assert_counterparty_usable(seeded_db, peer.id)
        assert exc.value.code == ErrorCode.COUNTERPARTY_DISABLED

    def test_role_type_mismatch_rejected(self, seeded_db):
        peer = service.create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            service.assert_counterparty_usable(seeded_db, peer.id, expected_type="SUPPLIER")
        assert exc.value.code == ErrorCode.PARTICIPANT_ROLE_INVALID


class TestFieldDefinitions:
    def test_inactive_field_keeps_history_and_blocks_new_value(self, seeded_db):
        definition = service.create_field_definition(
            seeded_db,
            entity_type="customer",
            field_key="preference",
            label="客户偏好",
            actor="pytest",
        )
        seeded_db.commit()
        customer = service.create_customer(seeded_db, display_name="甲", actor="pytest")
        seeded_db.commit()
        saved = service.set_extra_values(
            seeded_db,
            entity_type="customer",
            entity_id=customer.id,
            values=[("preference", "低价")],
        )
        seeded_db.commit()
        assert saved == {"preference": "低价"}

        service.set_field_definition_active(seeded_db, definition.id, False, actor="pytest")
        seeded_db.commit()
        assert service.get_extra_values(
            seeded_db, entity_type="customer", entity_id=customer.id
        ) == {"preference": "低价"}
        with pytest.raises(Exception) as exc:
            service.set_extra_values(
                seeded_db,
                entity_type="customer",
                entity_id=customer.id,
                values=[("preference", "高价")],
            )
        assert exc.value.code == ErrorCode.VALIDATION_ERROR


class TestPartiesApi:
    def test_create_customer_returns_duplicate_candidates(self, seeded_client, headers):
        seeded_client.post(
            CUSTOMERS, json={"display_name": "甲", "wechat": "wx001"}, headers=headers
        )
        response = seeded_client.post(
            CUSTOMERS, json={"display_name": "乙", "wechat": "wx001"}, headers=headers
        )
        assert response.status_code == 201
        body = response.json()
        assert body["customer"]["customer_no"] == "CUS0002"
        assert len(body["duplicate_candidates"]) == 1

    def test_reveal_contact_writes_audit(self, seeded_client, headers, seeded_db):
        created = seeded_client.post(
            CUSTOMERS, json={"display_name": "甲", "phone": "13800001234"}, headers=headers
        ).json()
        detail = seeded_client.get(
            f"{CUSTOMERS}/{created['customer']['id']}?reveal=true", headers=headers
        ).json()
        assert detail["phone"] == "13800001234"
        seeded_db.commit()
        audits = seeded_db.scalars(
            select(AuditLog).where(AuditLog.action == AuditAction.CONTACT_READ.value)
        ).all()
        assert len(audits) == 1

    def test_viewer_cannot_create_customer(self, seeded_client, viewer_headers):
        response = seeded_client.post(
            CUSTOMERS, json={"display_name": "甲"}, headers=viewer_headers
        )
        assert response.status_code == 403
        assert response.json()["code"] == ErrorCode.PERMISSION_DENIED

    def test_counterparty_endpoints(self, seeded_client, headers):
        created = seeded_client.post(
            COUNTERPARTIES, json={"display_name": "同行A", "type": "PEER"}, headers=headers
        )
        assert created.status_code == 201
        assert created.json()["counterparty_no"] == "CP0001"
        disabled = seeded_client.patch(
            f"{COUNTERPARTIES}/{created.json()['id']}/status?active=false", headers=headers
        )
        assert disabled.json()["status"] == "DISABLED"

    def test_field_definition_endpoints(self, seeded_client, headers):
        created = seeded_client.post(
            FIELDS,
            json={"entity_type": "customer", "field_key": "budget", "label": "预算"},
            headers=headers,
        )
        assert created.status_code == 201
        listed = seeded_client.get(f"{FIELDS}?entity_type=customer", headers=headers)
        assert len(listed.json()) == 1
