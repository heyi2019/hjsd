"""tests/v1/test_parties：客户、合作方、活字段（CUS-01 / BAS-02-05 / BAS-04 / A10 / A11）。"""
from __future__ import annotations

import pytest
from datetime import date, datetime
from sqlalchemy import select

from app.core.errors import ErrorCode
from app.domain.enums import AuditAction, CustomerStatus
from app.domain.foundation import AuditLog
from app.domain.parties import Customer, FieldDefinition, OrderCustomerRole
from app.domain.trade import Order
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
        # 迁移 0008 后 order_customer_roles.order_id 指向 orders，占位订单 1 必须先存在
        seeded_db.add(Order(
            id=1, order_no="ORD0001", order_type="HS", capital_type="STOCK",
            trade_date=date.today(), status="ACTIVE", link_status="UNLINKED",
            created_by="pytest", updated_by="pytest", created_at=datetime.now(), updated_at=datetime.now(),
        ))
        seeded_db.flush()
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


class TestCustomerExtraValues:
    """活字段随客户建档落库、类型校验、删除守卫（BAS-04）。"""

    def _defs(self, seeded_db):
        service.create_field_definition(
            seeded_db, entity_type="customer", field_key="game_category",
            label="常玩品类", actor="pytest", field_type="MULTI_SELECT",
            options=["王者荣耀", "和平精英"], sort_order=10,
        )
        service.create_field_definition(
            seeded_db, entity_type="customer", field_key="credit_level",
            label="信用评级", actor="pytest", field_type="SELECT",
            options=["优质", "一般", "观察", "黑名单"], sort_order=20,
        )
        service.create_field_definition(
            seeded_db, entity_type="customer", field_key="budget",
            label="预算", actor="pytest", field_type="NUMBER", required=True, sort_order=30,
        )
        seeded_db.commit()

    def test_create_customer_persists_extra_values(self, seeded_db):
        self._defs(seeded_db)
        customer = service.create_customer(
            seeded_db, display_name="甲", actor="pytest",
            extra_values={"game_category": ["王者荣耀"], "credit_level": "优质", "budget": 500},
        )
        seeded_db.commit()
        out = service.to_customer_out(
            customer, reveal_contact=True,
            extra_values=service.get_extra_values(
                seeded_db, entity_type="customer", entity_id=customer.id
            ),
        )
        assert out["extra_values"] == {
            "game_category": ["王者荣耀"], "credit_level": "优质", "budget": 500,
        }

    def test_required_field_missing_rejected(self, seeded_db):
        self._defs(seeded_db)
        with pytest.raises(Exception) as exc:
            service.create_customer(
                seeded_db, display_name="甲", actor="pytest",
                extra_values={"credit_level": "优质"},
            )
        assert exc.value.code == ErrorCode.VALIDATION_ERROR
        assert "budget" in exc.value.details["fields"]

    def test_select_value_outside_options_rejected(self, seeded_db):
        self._defs(seeded_db)
        with pytest.raises(Exception) as exc:
            service.create_customer(
                seeded_db, display_name="甲", actor="pytest",
                extra_values={"credit_level": "不存在", "budget": 1},
            )
        assert exc.value.code == ErrorCode.VALIDATION_ERROR

    def test_number_field_rejects_text(self, seeded_db):
        self._defs(seeded_db)
        with pytest.raises(Exception) as exc:
            service.create_customer(
                seeded_db, display_name="甲", actor="pytest", extra_values={"budget": "五百"}
            )
        assert exc.value.code == ErrorCode.VALIDATION_ERROR

    def test_update_customer_extra_values(self, seeded_db):
        self._defs(seeded_db)
        customer = service.create_customer(
            seeded_db, display_name="甲", actor="pytest", extra_values={"budget": 500}
        )
        seeded_db.commit()
        service.update_customer(
            seeded_db, customer.id, actor="pytest", extra_values={"credit_level": "观察"}
        )
        seeded_db.commit()
        assert service.get_extra_values(
            seeded_db, entity_type="customer", entity_id=customer.id
        ) == {"budget": 500, "credit_level": "观察"}

    def test_bulk_extra_values_for_list(self, seeded_db):
        self._defs(seeded_db)
        first = service.create_customer(
            seeded_db, display_name="甲", actor="pytest", extra_values={"budget": 100}
        )
        second = service.create_customer(
            seeded_db, display_name="乙", actor="pytest", extra_values={"budget": 200}
        )
        seeded_db.commit()
        bulk = service.get_extra_values_bulk(
            seeded_db, entity_type="customer", entity_ids=[first.id, second.id]
        )
        assert bulk[first.id] == {"budget": 100}
        assert bulk[second.id] == {"budget": 200}

    def test_delete_definition_with_values_only_deactivates(self, seeded_db):
        self._defs(seeded_db)
        definition = seeded_db.scalar(
            select(FieldDefinition).where(FieldDefinition.field_key == "budget")
        )
        customer = service.create_customer(
            seeded_db, display_name="甲", actor="pytest", extra_values={"budget": 1}
        )
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            service.delete_field_definition(seeded_db, definition.id, actor="pytest")
        assert exc.value.code == ErrorCode.FIELD_DEFINITION_HAS_VALUES
        # 有历史值只能停用：停用后值仍在，新写被拒
        service.set_field_definition_active(seeded_db, definition.id, False, actor="pytest")
        seeded_db.commit()
        assert service.get_extra_values(
            seeded_db, entity_type="customer", entity_id=customer.id
        ) == {"budget": 1}

    def test_delete_definition_without_values_removed(self, seeded_db):
        self._defs(seeded_db)
        definition = seeded_db.scalar(
            select(FieldDefinition).where(FieldDefinition.field_key == "budget")
        )
        service.delete_field_definition(seeded_db, definition.id, actor="pytest")
        seeded_db.commit()
        assert seeded_db.get(FieldDefinition, definition.id) is None


class TestExtraValuesApi:
    def test_create_and_read_customer_extra_values(self, seeded_client, headers):
        seeded_client.post(
            FIELDS,
            json={
                "entity_type": "customer", "field_key": "credit_level", "label": "信用评级",
                "field_type": "SELECT", "options": ["优质", "观察"],
            },
            headers=headers,
        )
        created = seeded_client.post(
            CUSTOMERS,
            json={"display_name": "甲", "extra_values": {"credit_level": "优质"}},
            headers=headers,
        )
        assert created.status_code == 201
        assert created.json()["customer"]["extra_values"] == {"credit_level": "优质"}
        detail = seeded_client.get(
            f"{CUSTOMERS}/{created.json()['customer']['id']}", headers=headers
        ).json()
        assert detail["extra_values"] == {"credit_level": "优质"}
        listed = seeded_client.get(CUSTOMERS, headers=headers).json()
        assert listed[0]["extra_values"] == {"credit_level": "优质"}

    def test_delete_field_definition_guarded_by_values(self, seeded_client, headers):
        field = seeded_client.post(
            FIELDS,
            json={"entity_type": "customer", "field_key": "budget", "label": "预算", "field_type": "NUMBER"},
            headers=headers,
        ).json()
        deleted = seeded_client.delete(f"{FIELDS}/{field['id']}", headers=headers)
        assert deleted.status_code == 204
        assert seeded_client.get(f"{FIELDS}?entity_type=customer", headers=headers).json() == []

        field2 = seeded_client.post(
            FIELDS,
            json={"entity_type": "customer", "field_key": "budget2", "label": "预算2", "field_type": "NUMBER"},
            headers=headers,
        ).json()
        seeded_client.post(
            CUSTOMERS,
            json={"display_name": "甲", "extra_values": {"budget2": 10}},
            headers=headers,
        )
        blocked = seeded_client.delete(f"{FIELDS}/{field2['id']}", headers=headers)
        assert blocked.status_code == 409
        assert blocked.json()["code"] == ErrorCode.FIELD_DEFINITION_HAS_VALUES

    def test_viewer_cannot_delete_field_definition(self, seeded_client, viewer_headers):
        field = seeded_client.post(
            FIELDS,
            json={"entity_type": "customer", "field_key": "note_x", "label": "备注X"},
            headers={"X-Dev-User": "admin"},
        ).json()
        response = seeded_client.delete(f"{FIELDS}/{field['id']}", headers=viewer_headers)
        assert response.status_code == 403
        assert response.json()["code"] == ErrorCode.PERMISSION_DENIED
