"""PARTY-01 tests/backend/test_parties：客户、合作方、表单扩展字段（CUS-01 / BAS-02-05 / BAS-04 / A10 / A11）。"""
from __future__ import annotations

import pytest
from datetime import date, datetime
from sqlalchemy import select

from app.core.errors import ErrorCode
from app.core.security import CurrentUser
from app.domain.enums import AuditAction, CustomerStatus
from app.domain.foundation import AuditLog
from app.domain.parties import Customer, OrderCustomerRole
from app.domain.trade import Order, OrderFormField
from app.parties._common import to_customer_out
from app.parties.counterparties import assert_counterparty_usable, create_counterparty, set_counterparty_status
from app.parties.customer_merge import assert_customer_usable, duplicate_candidates, merge_customers
from app.parties.customers import create_customer, set_customer_status, update_customer
from app.parties.fields import get_extra_values, get_extra_values_bulk, set_extra_values

CUSTOMERS = "/api/v1/customers"
COUNTERPARTIES = "/api/v1/counterparties"


def _user(uid=2, perms=(), pool_ids=(), owner_scope="SELF") -> CurrentUser:
    return CurrentUser(
        id=uid,
        username=f"u{uid}",
        roles=(),
        permissions=frozenset(perms),
        pool_ids=frozenset(pool_ids),
        owner_scope=owner_scope,
    )


class TestCustomerNumbering:
    def test_cus_number_allocated_independently(self, seeded_db):
        first = create_customer(seeded_db, display_name="阿甲", actor="pytest")
        second = create_customer(seeded_db, display_name="阿乙", actor="pytest")
        seeded_db.commit()
        assert first.customer_no == "CUS0001"
        assert second.customer_no == "CUS0002"

    def test_duplicate_contact_does_not_block(self, seeded_db):
        """联系方式允许重复：只返回候选，不拦截建档（CUS-01-05）。"""
        first = create_customer(seeded_db, display_name="甲", wechat="wx001", actor="pytest")
        seeded_db.commit()
        second = create_customer(seeded_db, display_name="乙", wechat="wx001", actor="pytest")
        candidates = duplicate_candidates(
            seeded_db, wechat="wx001", exclude_customer_id=second.id
        )
        seeded_db.commit()
        assert second.customer_no == "CUS0002"
        assert [item["customer_id"] for item in candidates] == [first.id]
        assert candidates[0]["matched_on"] == ["wechat"]

    def test_customer_number_is_not_reused_after_merge(self, seeded_db):
        source = create_customer(seeded_db, display_name="待合并", actor="pytest")
        target = create_customer(seeded_db, display_name="合并目标", actor="pytest")
        merge_customers(
            seeded_db, source_customer_id=source.id, target_customer_id=target.id,
            reason="重复建档", actor="pytest",
        )
        third = create_customer(seeded_db, display_name="新客户", actor="pytest")
        assert third.customer_no != source.customer_no


class TestContactOutput:
    def test_customer_output_returns_full_contact(self, seeded_db):
        customer = create_customer(
            seeded_db,
            display_name="甲",
            phone="13800001234",
            wechat="wxabc",
            qq="123456",
            actor="pytest",
        )
        seeded_db.commit()
        out = to_customer_out(customer)
        assert out["phone"] == "13800001234"
        assert out["wechat"] == "wxabc"
        assert out["qq"] == "123456"


class TestCustomerUsability:
    def test_disabled_customer_rejected(self, seeded_db):
        customer = create_customer(seeded_db, display_name="甲", actor="pytest")
        seeded_db.commit()
        set_customer_status(seeded_db, customer.id, "DISABLED", actor="pytest")
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            assert_customer_usable(seeded_db, customer.id)
        assert exc.value.code == ErrorCode.CUSTOMER_DISABLED

    def test_merged_customer_rejected(self, seeded_db):
        source = create_customer(seeded_db, display_name="源", actor="pytest")
        target = create_customer(seeded_db, display_name="目标", actor="pytest")
        seeded_db.commit()
        merge_customers(
            seeded_db,
            source_customer_id=source.id,
            target_customer_id=target.id,
            reason="同一微信",
            actor="admin",
        )
        seeded_db.commit()
        assert source.status == CustomerStatus.MERGED.value
        with pytest.raises(Exception) as exc:
            assert_customer_usable(seeded_db, source.id)
        assert exc.value.code == ErrorCode.CUSTOMER_DISABLED


class TestMerge:
    def test_merge_moves_roles_and_keeps_history(self, seeded_db):
        source = create_customer(seeded_db, display_name="源", actor="pytest")
        target = create_customer(seeded_db, display_name="目标", actor="pytest")
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

        merge_customers(
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
        source = create_customer(seeded_db, display_name="源", actor="pytest")
        target = create_customer(seeded_db, display_name="目标", actor="pytest")
        seeded_db.commit()
        set_customer_status(seeded_db, target.id, "DISABLED", actor="pytest")
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            merge_customers(
                seeded_db,
                source_customer_id=source.id,
                target_customer_id=target.id,
                reason="x",
                actor="admin",
            )
        assert exc.value.code == ErrorCode.MERGE_TARGET_INVALID


class TestCounterparty:
    def test_counterparty_is_not_persisted_as_customer(self, seeded_db):
        peer = create_counterparty(seeded_db, display_name="同行隔离", type="PEER", actor="pytest")
        found = seeded_db.scalar(
            select(Customer).where(Customer.display_name == "同行隔离")
        )
        assert found is None
        assert peer.counterparty_no.startswith("CP")

    def test_cp_number_and_type_separation(self, seeded_db):
        peer = create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        supplier = create_counterparty(
            seeded_db, display_name="供货方B", type="SUPPLIER", actor="pytest"
        )
        seeded_db.commit()
        assert peer.counterparty_no == "CP0001"
        assert supplier.counterparty_no == "CP0002"
        assert seeded_db.scalar(select(Customer).where(Customer.display_name == "同行A")) is None

    def test_invalid_type_rejected(self, seeded_db):
        with pytest.raises(Exception) as exc:
            create_counterparty(
                seeded_db, display_name="X", type="CUSTOMER", actor="pytest"
            )
        assert exc.value.code == ErrorCode.VALIDATION_ERROR

    def test_disabled_counterparty_rejected(self, seeded_db):
        peer = create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        seeded_db.commit()
        set_counterparty_status(seeded_db, peer.id, False, actor="pytest")
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            assert_counterparty_usable(seeded_db, peer.id)
        assert exc.value.code == ErrorCode.COUNTERPARTY_DISABLED

    def test_role_type_mismatch_rejected(self, seeded_db):
        peer = create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        seeded_db.commit()
        with pytest.raises(Exception) as exc:
            assert_counterparty_usable(seeded_db, peer.id, expected_type="SUPPLIER")
        assert exc.value.code == ErrorCode.PARTICIPANT_ROLE_INVALID


class TestFieldDefinitions:
    def test_inactive_field_keeps_history_and_blocks_new_value(self, seeded_db):
        definition = OrderFormField(
            order_type_code="CUSTOMER", field_key="preference", label="客户偏好",
            field_type="TEXT", is_custom=True,
            created_by="pytest", updated_by="pytest",
        )
        seeded_db.add(definition)
        seeded_db.commit()
        customer = create_customer(seeded_db, display_name="甲", actor="pytest")
        seeded_db.commit()
        saved = set_extra_values(
            seeded_db,
            entity_type="customer",
            entity_id=customer.id,
            values=[("preference", "低价")],
        )
        seeded_db.commit()
        assert saved == {"preference": "低价"}

        definition.is_active = False
        seeded_db.commit()
        assert get_extra_values(
            seeded_db, entity_type="customer", entity_id=customer.id
        ) == {"preference": "低价"}
        with pytest.raises(Exception) as exc:
            set_extra_values(
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

    def test_customer_contact_is_full_without_reveal_audit(self, seeded_client, headers, seeded_db):
        created = seeded_client.post(
            CUSTOMERS, json={"display_name": "甲", "phone": "13800001234"}, headers=headers
        ).json()
        detail = seeded_client.get(f"{CUSTOMERS}/{created['customer']['id']}", headers=headers).json()
        assert detail["phone"] == "13800001234"
        seeded_db.commit()
        assert all(row.action != "CONTACT_READ" for row in seeded_db.scalars(select(AuditLog)).all())

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

    def test_patch_can_clear_customer_and_counterparty_contacts(self, seeded_client, headers):
        customer = seeded_client.post(
            CUSTOMERS,
            json={"display_name": "客户A", "phone": "13800000000", "wechat": "wx-a", "note": "旧"},
            headers=headers,
        ).json()["customer"]
        customer_updated = seeded_client.patch(
            f"{CUSTOMERS}/{customer['id']}",
            json={"phone": None, "wechat": None, "note": None},
            headers=headers,
        )
        assert customer_updated.status_code == 200, customer_updated.text
        assert customer_updated.json()["phone"] is None
        assert customer_updated.json()["wechat"] is None
        assert customer_updated.json()["note"] is None

        counterparty = seeded_client.post(
            COUNTERPARTIES,
            json={"display_name": "同行A", "type": "PEER", "phone": "13800000001", "note": "旧"},
            headers=headers,
        ).json()
        counterparty_updated = seeded_client.patch(
            f"{COUNTERPARTIES}/{counterparty['id']}",
            json={"phone": None, "note": None},
            headers=headers,
        )
        assert counterparty_updated.status_code == 200, counterparty_updated.text
        assert counterparty_updated.json()["phone"] is None
        assert counterparty_updated.json()["note"] is None

class TestCustomerExtraValues:
    """表单扩展字段随客户建档落库、类型校验、删除守卫（BAS-04）。"""

    def _defs(self, seeded_db):
        for field_key, label, field_type, options, required, sort_order in (
            ("game_category", "常玩品类", "MULTI_SELECT", ["王者荣耀", "和平精英"], False, 10),
            ("credit_level", "信用评级", "SELECT", ["优质", "一般", "观察", "黑名单"], False, 20),
            ("budget", "预算", "NUMBER", None, True, 30),
        ):
            seeded_db.add(
                OrderFormField(
                    order_type_code="CUSTOMER", field_key=field_key, label=label,
                    field_type=field_type, options=options, required=required,
                    sort_order=sort_order, is_custom=True,
                    created_by="pytest", updated_by="pytest",
                )
            )
        seeded_db.commit()

    def test_create_customer_persists_extra_values(self, seeded_db):
        self._defs(seeded_db)
        customer = create_customer(
            seeded_db, display_name="甲", actor="pytest",
            extra_values={"game_category": ["王者荣耀"], "credit_level": "优质", "budget": 500},
        )
        seeded_db.commit()
        out = to_customer_out(
            customer,
            extra_values=get_extra_values(
                seeded_db, entity_type="customer", entity_id=customer.id
            ),
        )
        assert out["extra_values"] == {
            "game_category": ["王者荣耀"], "credit_level": "优质", "budget": 500,
        }

    def test_required_field_missing_rejected(self, seeded_db):
        self._defs(seeded_db)
        with pytest.raises(Exception) as exc:
            create_customer(
                seeded_db, display_name="甲", actor="pytest",
                extra_values={"credit_level": "优质"},
            )
        assert exc.value.code == ErrorCode.VALIDATION_ERROR
        assert "budget" in exc.value.details["fields"]

    def test_select_value_outside_options_rejected(self, seeded_db):
        self._defs(seeded_db)
        with pytest.raises(Exception) as exc:
            create_customer(
                seeded_db, display_name="甲", actor="pytest",
                extra_values={"credit_level": "不存在", "budget": 1},
            )
        assert exc.value.code == ErrorCode.VALIDATION_ERROR

    def test_number_field_rejects_text(self, seeded_db):
        self._defs(seeded_db)
        with pytest.raises(Exception) as exc:
            create_customer(
                seeded_db, display_name="甲", actor="pytest", extra_values={"budget": "五百"}
            )
        assert exc.value.code == ErrorCode.VALIDATION_ERROR

    def test_update_customer_extra_values(self, seeded_db):
        self._defs(seeded_db)
        customer = create_customer(
            seeded_db, display_name="甲", actor="pytest", extra_values={"budget": 500}
        )
        seeded_db.commit()
        update_customer(
            seeded_db, customer.id, actor="pytest", extra_values={"credit_level": "观察"}
        )
        seeded_db.commit()
        assert get_extra_values(
            seeded_db, entity_type="customer", entity_id=customer.id
        ) == {"budget": 500, "credit_level": "观察"}

    def test_bulk_extra_values_for_list(self, seeded_db):
        self._defs(seeded_db)
        first = create_customer(
            seeded_db, display_name="甲", actor="pytest", extra_values={"budget": 100}
        )
        second = create_customer(
            seeded_db, display_name="乙", actor="pytest", extra_values={"budget": 200}
        )
        seeded_db.commit()
        bulk = get_extra_values_bulk(
            seeded_db, entity_type="customer", entity_ids=[first.id, second.id]
        )
        assert bulk[first.id] == {"budget": 100}
        assert bulk[second.id] == {"budget": 200}

class TestExtraValuesApi:
    def test_create_and_read_customer_extra_values(self, seeded_client, seeded_db, headers):
        seeded_db.add(
            OrderFormField(
                order_type_code="CUSTOMER", field_key="credit_level", label="信用评级",
                field_type="SELECT", options=["优质", "观察"], is_custom=True,
                created_by="pytest", updated_by="pytest",
            )
        )
        seeded_db.commit()
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
        assert listed["items"][0]["extra_values"] == {"credit_level": "优质"}


# 客户和合作方联系方式直接返回原值

def test_counterparty_list_returns_full_contact(seeded_client):
    seeded_client.post(
        COUNTERPARTIES,
        json={
            "display_name": "同行甲", "type": "PEER", "phone": "13800009999",
            "wechat": "wx_peer_001", "qq": "123456789",
        },
        headers={"X-Dev-User": "admin"},
    )
    resp = seeded_client.get(COUNTERPARTIES, headers={"X-Dev-User": "employee"})
    assert resp.status_code == 200, resp.text
    row = resp.json()[0]
    assert "contact_masked" not in row
    assert row["phone"] == "13800009999"
    assert row["wechat"] == "wx_peer_001"

def test_counterparty_detail_returns_full_contact_without_read_audit(seeded_client, seeded_db):
    cp = seeded_client.post(
        COUNTERPARTIES,
        json={"display_name": "同行乙", "type": "PEER", "phone": "13800008888"},
        headers={"X-Dev-User": "admin"},
    ).json()

    full = seeded_client.get(f"{COUNTERPARTIES}/{cp['id']}", headers={"X-Dev-User": "employee"}).json()
    assert "contact_masked" not in full
    assert full["phone"] == "13800008888"
    seeded_db.commit()
    assert all(row.action != "CONTACT_READ" for row in seeded_db.scalars(select(AuditLog)).all())

def test_customer_update_honors_contact_permission(seeded_client):
    """更新接口直接返回原联系方式，不依赖额外读取权限。"""
    created = seeded_client.post(
        CUSTOMERS,
        json={"display_name": "客户丙", "phone": "13800007777"},
        headers={"X-Dev-User": "admin"},
    ).json()["customer"]
    resp = seeded_client.patch(
        f"{CUSTOMERS}/{created['id']}",
        json={"note": "已更新"},
        headers={"X-Dev-User": "admin"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["phone"] == "13800007777"

def test_customer_update_returns_full_contact_without_read_permission(seeded_db):
    cust = create_customer(
        seeded_db, display_name="客户丁", phone="13800006666", actor="pytest"
    )
    out = to_customer_out(cust)
    assert out["phone"] == "13800006666"
