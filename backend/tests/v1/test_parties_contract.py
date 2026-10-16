"""parties 客户/合作方契约测试（CUS-01 / BAS-02-05 / BAS-04）。

与 test_parties.py 的分工：既有文件已覆盖编号域、脱敏主路径、停用/合并参与方校验、
合并迁移主路径、字段停用保留历史值、以及创建客户/合作方/字段端点；
本文件补脱敏边界（空值/短串）、建单必填校验、查重空条件、查询三过滤+作用域、
客户更新（含已合并冲突与联系方式审计分流）、状态机 MERGED 守卫、
合并同源/已合并/重复角色去重、合作方查询与更新、字段定义三项校验与停用过滤、
活字段覆写，以及 7 个未测路由端点。
"""
from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select

from app.core.errors import Conflict, NotFound, Validation
from app.core.security import CurrentUser
from app.domain.enums import AuditAction, CounterpartyStatus, CustomerStatus
from app.domain.foundation import AuditLog
from app.domain.parties import OrderCustomerRole
from app.orders import service as orders_service
from app.parties import service

CUSTOMERS = "/api/v1/customers"
COUNTERPARTIES = "/api/v1/counterparties"
FIELDS = "/api/v1/field-definitions"


def _scoped_user() -> CurrentUser:
    """非 admin、SELF 作用域用户（可见集只有自己）。"""
    return CurrentUser.build(
        id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
    )


def _customer(seeded_db, name: str, **kwargs):
    return service.create_customer(seeded_db, display_name=name, actor="pytest", **kwargs)


def _audit_actions(seeded_db, action: AuditAction) -> list[str]:
    rows = seeded_db.scalars(
        select(AuditLog).where(AuditLog.action == action.value)
    ).all()
    return [row.entity_id for row in rows]


# ------------------------------------------------------------------ 脱敏边界
class TestMaskingEdgeCases:
    def test_mask_phone_empty_and_short(self, seeded_db):
        assert service.mask_phone(None) is None  # 46
        assert service.mask_phone("") == ""
        assert service.mask_phone("12345") == "123**"  # 49（长度 ≤ 7 走短串分支）

    def test_mask_id_empty_and_short(self, seeded_db):
        assert service.mask_id(None) is None  # 56
        assert service.mask_id("") == ""
        assert service.mask_id("ab") == "a*"  # 59（长度 ≤ 2 走短串分支）


# ------------------------------------------------------------------ 客户建档
class TestCreateCustomerGuards:
    def test_empty_display_name_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.create_customer(seeded_db, display_name="   ", actor="pytest")
        assert "称呼/昵称必填" in str(exc.value)

    def test_duplicate_candidates_without_conditions_returns_empty(self, seeded_db):
        # 150：无任何联系方式入参 → 直接返回空候选，不查库
        assert service.duplicate_candidates(seeded_db) == []


# ------------------------------------------------------------------ 客户查询
class TestListAndGetCustomers:
    def test_list_filters_keyword_status_and_scope(self, seeded_db):
        mine = _customer(seeded_db, "阿甲", phone="13800001111", owner_id=9)
        other = _customer(seeded_db, "阿乙", phone="13900002222", owner_id=1)
        service.set_customer_status(seeded_db, other.id, "DISABLED", actor="pytest")

        by_status = service.list_customers(seeded_db, status=CustomerStatus.ACTIVE.value)
        assert [c.id for c in by_status] == [mine.id]

        by_name = service.list_customers(seeded_db, keyword="阿甲")
        assert [c.id for c in by_name] == [mine.id]
        # 关键词同时匹配客户编号/手机/微信/QQ
        by_phone = service.list_customers(seeded_db, keyword="13800001111")
        assert [c.id for c in by_phone] == [mine.id]

        scoped = service.list_customers(seeded_db, user=_scoped_user())
        assert [c.id for c in scoped] == [mine.id]
        assert other.id not in [c.id for c in scoped]

    def test_get_customer_notfound_and_scope_forbidden(self, seeded_db):
        with pytest.raises(NotFound):
            service.get_customer(seeded_db, 999999)
        # 他人 owner 的客户对 SELF 作用域同样 404（不泄露存在性）
        other = _customer(seeded_db, "阿丙", owner_id=1)
        with pytest.raises(NotFound):
            service.get_customer(seeded_db, other.id, _scoped_user())


# ------------------------------------------------------------------ 客户更新
class TestUpdateCustomer:
    def test_merged_customer_cannot_be_updated(self, seeded_db):
        source = _customer(seeded_db, "源")
        target = _customer(seeded_db, "目标")
        service.merge_customers(
            seeded_db,
            source_customer_id=source.id,
            target_customer_id=target.id,
            reason="同一微信",
            actor="admin",
        )
        with pytest.raises(Conflict) as exc:
            service.update_customer(seeded_db, source.id, actor="pytest", note="x")
        assert "已合并客户不可修改" in str(exc.value)

    def test_contact_change_writes_contact_audit(self, seeded_db):
        customer = _customer(seeded_db, "阿甲", phone="13800001111")
        service.update_customer(
            seeded_db, customer.id, actor="pytest", phone="13800009999", note=None
        )
        assert customer.phone == "13800009999"
        assert customer.note is None  # None 入参被跳过，不覆写（224）
        assert _audit_actions(seeded_db, AuditAction.CONTACT_WRITE) == [
            customer.customer_no
        ]
        assert _audit_actions(seeded_db, AuditAction.CUSTOMER_UPDATE) == []

    def test_non_contact_change_writes_customer_audit(self, seeded_db):
        customer = _customer(seeded_db, "阿甲")
        service.update_customer(seeded_db, customer.id, actor="pytest", source="转介绍")
        assert customer.source == "转介绍"
        assert _audit_actions(seeded_db, AuditAction.CUSTOMER_UPDATE) == [
            customer.customer_no
        ]
        assert _audit_actions(seeded_db, AuditAction.CONTACT_WRITE) == []

    def test_status_cannot_be_set_to_merged_manually(self, seeded_db):
        customer = _customer(seeded_db, "阿甲")
        with pytest.raises(Validation) as exc:
            service.set_customer_status(
                seeded_db, customer.id, CustomerStatus.MERGED.value, actor="pytest"
            )
        assert "MERGED 只能由合并动作产生" in str(exc.value)


# ------------------------------------------------------------------ 合并守卫
class TestMergeGuards:
    def test_same_source_and_target_rejected(self, seeded_db):
        customer = _customer(seeded_db, "阿甲")
        with pytest.raises(Validation) as exc:
            service.merge_customers(
                seeded_db,
                source_customer_id=customer.id,
                target_customer_id=customer.id,
                reason="自查",
                actor="admin",
            )
        assert "来源与目标不能是同一客户" in str(exc.value)

    def test_already_merged_source_rejected(self, seeded_db):
        source = _customer(seeded_db, "源")
        target = _customer(seeded_db, "目标")
        third = _customer(seeded_db, "第三方")
        service.merge_customers(
            seeded_db,
            source_customer_id=source.id,
            target_customer_id=target.id,
            reason="重复建档",
            actor="admin",
        )
        with pytest.raises(Validation) as exc:
            service.merge_customers(
                seeded_db,
                source_customer_id=source.id,
                target_customer_id=third.id,
                reason="再合一次",
                actor="admin",
            )
        assert "来源客户已合并" in str(exc.value)

    def test_duplicate_role_is_dropped_on_merge(self, seeded_db):
        order = orders_service.create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest"
        )
        source = _customer(seeded_db, "源")
        target = _customer(seeded_db, "目标")
        seeded_db.add_all(
            [
                OrderCustomerRole(order_id=order.id, customer_id=source.id, role="SELLER"),
                OrderCustomerRole(order_id=order.id, customer_id=target.id, role="SELLER"),
            ]
        )
        seeded_db.flush()

        service.merge_customers(
            seeded_db,
            source_customer_id=source.id,
            target_customer_id=target.id,
            reason="同订单重复角色",
            actor="admin",
        )
        # 目标已有同订单同角色 → 来源角色被丢弃而非迁移（309-310）
        roles = seeded_db.scalars(
            select(OrderCustomerRole).where(
                OrderCustomerRole.order_id == order.id,
                OrderCustomerRole.role == "SELLER",
            )
        ).all()
        assert [r.customer_id for r in roles] == [target.id]


# ------------------------------------------------------------------ 合作方
class TestCounterpartyGuards:
    def test_empty_display_name_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.create_counterparty(
                seeded_db, display_name="  ", type="PEER", actor="pytest"
            )
        assert "合作方名称必填" in str(exc.value)

    def test_list_filters_by_type_and_status(self, seeded_db):
        peer = service.create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        supplier = service.create_counterparty(
            seeded_db, display_name="供货方B", type="SUPPLIER", actor="pytest"
        )
        service.set_counterparty_status(seeded_db, supplier.id, False, actor="pytest")

        by_type = service.list_counterparties(seeded_db, type="PEER")
        assert [p.id for p in by_type] == [peer.id]
        by_status = service.list_counterparties(
            seeded_db, status=CounterpartyStatus.ACTIVE.value
        )
        assert [p.id for p in by_status] == [peer.id]

    def test_get_counterparty_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            service.get_counterparty(seeded_db, 999999)

    def test_update_counterparty_applies_fields(self, seeded_db):
        peer = service.create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        updated = service.update_counterparty(
            seeded_db, peer.id, actor="pytest", display_name="同行A2", note="长期合作",
            phone=None,
        )
        assert updated.display_name == "同行A2"
        assert updated.note == "长期合作"
        assert updated.updated_by == "pytest"
        assert _audit_actions(seeded_db, AuditAction.CUSTOMER_UPDATE) == [
            peer.counterparty_no
        ]


# ------------------------------------------------------------------ 活字段
class TestFieldDefinitionGuards:
    def test_invalid_entity_type_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.create_field_definition(
                seeded_db, entity_type="BOGUS", field_key="k1", label="字段",
                actor="pytest",
            )
        assert "实体类型必须为" in str(exc.value)

    @pytest.mark.parametrize("entity_type", ["account", "order"])
    def test_business_entities_cannot_define_live_fields(self, seeded_db, entity_type):
        with pytest.raises(Validation):
            service.create_field_definition(
                seeded_db,
                entity_type=entity_type,
                field_key="custom_note",
                label="自定义备注",
                actor="pytest",
            )

    def test_invalid_field_key_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.create_field_definition(
                seeded_db, entity_type="customer", field_key="Bad_Key", label="字段",
                actor="pytest",
            )
        assert "字段键必须为小写字母开头" in str(exc.value)

    def test_duplicate_field_key_conflicts(self, seeded_db):
        service.create_field_definition(
            seeded_db, entity_type="customer", field_key="k1", label="字段", actor="pytest"
        )
        with pytest.raises(Conflict) as exc:
            service.create_field_definition(
                seeded_db, entity_type="customer", field_key="k1", label="字段2",
                actor="pytest",
            )
        assert "已存在" in str(exc.value)

    def test_list_excludes_inactive_when_requested(self, seeded_db):
        definition = service.create_field_definition(
            seeded_db, entity_type="customer", field_key="k1", label="字段", actor="pytest"
        )
        service.set_field_definition_active(
            seeded_db, definition.id, False, actor="pytest"
        )
        assert service.list_field_definitions(
            seeded_db, entity_type="customer", include_inactive=False
        ) == []
        assert len(
            service.list_field_definitions(seeded_db, entity_type="customer")
        ) == 1

    def test_set_active_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            service.set_field_definition_active(
                seeded_db, 999999, False, actor="pytest"
            )

    def test_extra_value_overwrites_existing_row(self, seeded_db):
        definition = service.create_field_definition(
            seeded_db, entity_type="customer", field_key="k1", label="字段", actor="pytest"
        )
        customer = _customer(seeded_db, "阿甲")
        service.set_extra_values(
            seeded_db, entity_type="customer", entity_id=customer.id,
            values=[(definition.field_key, "v1")],
        )
        saved = service.set_extra_values(
            seeded_db, entity_type="customer", entity_id=customer.id,
            values=[(definition.field_key, "v2")],
        )
        assert saved == {"k1": "v2"}  # 618：已存在行走覆写分支，不重复插入
        assert service.get_extra_values(
            seeded_db, entity_type="customer", entity_id=customer.id
        ) == {"k1": "v2"}


# ------------------------------------------------------------------ 路由层
class TestPartiesApi:
    def test_list_customers_endpoint(self, seeded_client, seeded_db, headers):
        customer = _customer(seeded_db, "阿甲", phone="13800001111")
        response = seeded_client.get(
            CUSTOMERS, params={"keyword": "阿甲"}, headers=headers
        )
        assert response.status_code == 200, response.text
        # admin 具备 customer.contact.read → 不脱敏
        assert response.json()[0]["contact_masked"] is False
        assert response.json()[0]["id"] == customer.id

    def test_update_customer_endpoint(self, seeded_client, seeded_db, headers):
        customer = _customer(seeded_db, "阿甲")
        response = seeded_client.patch(
            f"{CUSTOMERS}/{customer.id}",
            json={"display_name": "阿甲2", "note": "回头客"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["display_name"] == "阿甲2"

    def test_update_customer_status_endpoint(self, seeded_client, seeded_db, headers):
        customer = _customer(seeded_db, "阿甲")
        response = seeded_client.patch(
            f"{CUSTOMERS}/{customer.id}/status",
            json={"status": "DISABLED"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["status"] == CustomerStatus.DISABLED.value

    def test_merge_customer_endpoint(self, seeded_client, seeded_db, headers):
        source = _customer(seeded_db, "源")
        target = _customer(seeded_db, "目标")
        response = seeded_client.post(
            f"{CUSTOMERS}/{source.id}/merge",
            json={"target_customer_id": target.id, "reason": "同一微信"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["id"] == target.id

    def test_list_counterparties_endpoint(self, seeded_client, seeded_db, headers):
        peer = service.create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        response = seeded_client.get(
            COUNTERPARTIES, params={"type": "PEER"}, headers=headers
        )
        assert response.status_code == 200, response.text
        assert [item["counterparty_no"] for item in response.json()] == [
            peer.counterparty_no
        ]

    def test_update_counterparty_endpoint(self, seeded_client, seeded_db, headers):
        peer = service.create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        response = seeded_client.patch(
            f"{COUNTERPARTIES}/{peer.id}", json={"note": "长期合作"}, headers=headers
        )
        assert response.status_code == 200, response.text
        assert response.json()["note"] == "长期合作"

    def test_set_field_definition_active_endpoint(self, seeded_client, seeded_db, headers):
        definition = service.create_field_definition(
            seeded_db, entity_type="customer", field_key="k1", label="字段", actor="pytest"
        )
        response = seeded_client.patch(
            f"{FIELDS}/{definition.id}/active",
            params={"active": "false"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["is_active"] is False
