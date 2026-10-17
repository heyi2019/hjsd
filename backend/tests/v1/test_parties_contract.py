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
from sqlalchemy.exc import IntegrityError

from app.core.audit import record_audit
from app.core.errors import Conflict, NotFound, Validation
from app.core.security import CurrentUser, build_access_token
from app.domain.enums import (
    AuditAction,
    CounterpartyStatus,
    CustomerStatus,
    ScheduleStatus,
)
from app.domain.foundation import AuditLog
from app.domain.parties import (
    EntityExtraValue,
    FieldDefinition,
    OrderCounterpartyRole,
    OrderCustomerRole,
)
from app.domain.trade import InstallmentSchedule
from app.installments import service as installment_service
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

    def test_extra_values_require_object_with_string_keys(self, seeded_db):
        with pytest.raises(Validation, match="活字段值必须为对象"):
            service.create_customer(
                seeded_db,
                display_name="活字段结构错误",
                actor="pytest",
                extra_values=["not-an-object"],
            )
        with pytest.raises(Validation, match="活字段键必须为非空字符串"):
            service.create_customer(
                seeded_db,
                display_name="活字段键错误",
                actor="pytest",
                extra_values={1: "value"},
            )

    def test_customer_owner_must_exist(self, seeded_db):
        with pytest.raises(Validation, match="客户负责人不存在"):
            service.create_customer(
                seeded_db, display_name="负责人校验", actor="pytest", owner_id=999999
            )

    def test_create_names_reject_non_text_values(self, seeded_db):
        with pytest.raises(Validation, match="称呼/昵称必填"):
            service.create_customer(seeded_db, display_name=123, actor="pytest")
        with pytest.raises(Validation, match="合作方名称必填"):
            service.create_counterparty(
                seeded_db, display_name=123, type="PEER", actor="pytest"
            )

    def test_duplicate_candidates_without_conditions_returns_empty(self, seeded_db):
        # 150：无任何联系方式入参 → 直接返回空候选，不查库
        assert service.duplicate_candidates(seeded_db) == []

    def test_duplicate_candidates_reject_non_text_contact_values(self, seeded_db):
        with pytest.raises(Validation, match="联系方式必须为文本"):
            service.duplicate_candidates(seeded_db, phone=123)

    def test_scoped_user_cannot_assign_created_customer_to_other_owner(
        self, seeded_client, seeded_db
    ):
        user = _scoped_user()
        response = seeded_client.post(
            CUSTOMERS,
            json={"display_name": "归属测试", "owner_id": 1},
            headers={"Authorization": f"Bearer {build_access_token(user)}"},
        )
        assert response.status_code == 201, response.text
        assert response.json()["customer"]["owner_id"] == user.id

    def test_duplicate_candidates_respect_owner_scope(
        self, seeded_client, seeded_db
    ):
        other = _customer(
            seeded_db, "他人同名联系方式", wechat="wx-scope", owner_id=1
        )
        user = _scoped_user()
        response = seeded_client.post(
            CUSTOMERS,
            json={"display_name": "我的客户", "wechat": "wx-scope"},
            headers={"Authorization": f"Bearer {build_access_token(user)}"},
        )

        assert response.status_code == 201, response.text
        assert all(
            item["customer_id"] != other.id
            for item in response.json()["duplicate_candidates"]
        )


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

    def test_customer_list_activity_summary_comes_from_order_relations(self, seeded_db):
        customer = _customer(seeded_db, "列表汇总客户", owner_id=9)
        order = orders_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=date(2026, 10, 12),
            customer_roles=[
                (customer.id, "SELLER"),
                (customer.id, "BUYER"),
            ],
            actor="pytest",
        )

        summary = service.get_customer_activity_summary(seeded_db, [customer.id])

        assert summary[customer.id]["order_roles"] == ["BUYER", "SELLER"]
        assert summary[customer.id]["active_order_count"] == 1
        assert summary[customer.id]["last_interaction_at"] == order.created_at

    def test_get_customer_notfound_and_scope_forbidden(self, seeded_db):
        with pytest.raises(NotFound):
            service.get_customer(seeded_db, 999999)
        # 他人 owner 的客户对 SELF 作用域同样 404（不泄露存在性）
        other = _customer(seeded_db, "阿丙", owner_id=1)
        with pytest.raises(NotFound):
            service.get_customer(seeded_db, other.id, _scoped_user())

    def test_customer_detail_aggregates_business_installments_and_audit(self, seeded_db):
        customer = _customer(seeded_db, "详情客户", owner_id=9)
        request_id = "customer-detail-trace-20261017"
        record_audit(
            seeded_db,
            action=AuditAction.CUSTOMER_UPDATE,
            entity_type="customer",
            entity_id=customer.customer_no,
            actor="pytest",
            request_id=request_id,
        )
        dfq = orders_service.create_order(
            seeded_db,
            order_type="DFQ",
            trade_date=date(2026, 10, 10),
            customer_roles=[(customer.id, "INSTALLMENT_CUSTOMER")],
            actor="pytest",
        )
        th = orders_service.create_order(
            seeded_db,
            order_type="TH",
            trade_date=date(2026, 10, 11),
            customer_roles=[(customer.id, "BUYER")],
            actor="pytest",
        )
        installment = installment_service.create_installment(
            seeded_db,
            order_id=dfq.id,
            contract_type="ADVANCE_PURCHASE",
            principal=500,
            down_payment=100,
            periods=1,
            per_period=400,
            first_due_on=date(2026, 9, 1),
            actor="pytest",
        )
        overdue = seeded_db.scalar(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == installment.id,
                InstallmentSchedule.period_no == 1,
            )
        )
        overdue.status = ScheduleStatus.OVERDUE.value
        seeded_db.flush()

        detail = service.get_customer_detail(seeded_db, customer.id)

        assert detail["overview"]["order_count"] == 2
        assert detail["overview"]["active_order_count"] == 2
        assert detail["overview"]["last_trade_date"] == date(2026, 10, 11)
        assert detail["overview"]["installment_paid_total"] == 0
        assert detail["overview"]["installment_receivable_total"] == 500
        assert detail["overview"]["overdue_period_count"] == 1
        assert {item["order_no"] for item in detail["business"]} == {
            dfq.order_no, th.order_no,
        }
        assert detail["business"][0]["roles"]
        assert detail["installments"][0]["inst_no"] == installment.inst_no
        assert detail["installments"][0]["remaining_amount"] == 500
        assert any(item["action"] == AuditAction.CUSTOMER_CREATE.value for item in detail["audit"])
        assert any(item["request_id"] == request_id for item in detail["audit"])


# ------------------------------------------------------------------ 客户更新
class TestUpdateCustomer:
    def test_customer_update_validates_all_fields_before_mutating(self, seeded_db):
        customer = _customer(seeded_db, "原客户")

        with pytest.raises(Validation, match="客户更新字段不受支持"):
            service.update_customer(
                seeded_db,
                customer.id,
                actor="operator",
                display_name="不应保存的新名称",
                unsupported_field="invalid",
            )

        seeded_db.commit()
        seeded_db.refresh(customer)
        assert customer.display_name == "原客户"
        assert customer.updated_by == "pytest"

    def test_customer_and_counterparty_names_cannot_be_blank_on_update(self, seeded_db):
        customer = _customer(seeded_db, "客户名")
        with pytest.raises(Validation, match="称呼/昵称不能清空"):
            service.update_customer(
                seeded_db, customer.id, actor="pytest", display_name="   "
            )

        counterparty = service.create_counterparty(
            seeded_db, display_name="合作方名", type="PEER", actor="pytest"
        )
        with pytest.raises(Validation, match="合作方名称不能清空"):
            service.update_counterparty(
                seeded_db, counterparty.id, actor="pytest", display_name="   "
            )

    def test_customer_mutations_respect_owner_scope(self, seeded_db):
        other = _customer(seeded_db, "他人客户", owner_id=1)

        with pytest.raises(NotFound):
            service.update_customer(
                seeded_db,
                other.id,
                actor="operator",
                user=_scoped_user(),
                note="越权修改",
            )
        with pytest.raises(NotFound):
            service.set_customer_status(
                seeded_db,
                other.id,
                CustomerStatus.DISABLED.value,
                actor="operator",
                user=_scoped_user(),
            )

    def test_scoped_user_cannot_reassign_customer_to_other_owner(
        self, seeded_client, seeded_db
    ):
        customer = _customer(seeded_db, "归属不可转移", owner_id=9)
        response = seeded_client.patch(
            f"{CUSTOMERS}/{customer.id}",
            json={"owner_id": 1},
            headers={"Authorization": f"Bearer {build_access_token(_scoped_user())}"},
        )
        assert response.status_code == 200, response.text
        assert response.json()["owner_id"] == 9

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

        with pytest.raises(Validation, match="已合并客户不可修改状态"):
            service.set_customer_status(
                seeded_db, source.id, CustomerStatus.ACTIVE.value, actor="pytest"
            )

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

    def test_status_rejects_unknown_value_in_service(self, seeded_db):
        customer = _customer(seeded_db, "阿甲")
        with pytest.raises(Validation) as exc:
            service.set_customer_status(
                seeded_db, customer.id, "PENDING", actor="pytest"
            )
        assert "客户状态无效" in str(exc.value)


# ------------------------------------------------------------------ 合并守卫
class TestMergeGuards:
    def test_merge_requires_non_blank_reason(self, seeded_db):
        source = _customer(seeded_db, "源")
        target = _customer(seeded_db, "目标")
        with pytest.raises(Validation, match="客户合并必须填写原因"):
            service.merge_customers(
                seeded_db,
                source_customer_id=source.id,
                target_customer_id=target.id,
                reason="  ",
                actor="admin",
            )

    def test_merge_does_not_load_foreign_customer_for_scoped_user(self, seeded_db):
        source = _customer(seeded_db, "他人来源", owner_id=1)
        target = _customer(seeded_db, "我的目标", owner_id=9)
        with pytest.raises(NotFound):
            service.merge_customers(
                seeded_db,
                source_customer_id=source.id,
                target_customer_id=target.id,
                reason="越权合并",
                actor="operator",
                user=_scoped_user(),
            )

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

    def test_merge_copies_missing_extra_values_to_target(self, seeded_db):
        definition = service.create_field_definition(
            seeded_db,
            entity_type="customer",
            field_key="preferred_platform",
            label="常用平台",
            actor="pytest",
        )
        source = _customer(seeded_db, "带活字段的源")
        target = _customer(seeded_db, "没有活字段的目标")
        service.set_extra_values(
            seeded_db,
            entity_type="customer",
            entity_id=source.id,
            values=[(definition.field_key, "王者荣耀")],
        )

        service.merge_customers(
            seeded_db,
            source_customer_id=source.id,
            target_customer_id=target.id,
            reason="资料合并",
            actor="admin",
        )

        assert service.get_extra_values(
            seeded_db, entity_type="customer", entity_id=target.id
        ) == {"preferred_platform": "王者荣耀"}
        assert service.get_extra_values(
            seeded_db, entity_type="customer", entity_id=source.id
        ) == {"preferred_platform": "王者荣耀"}


# ------------------------------------------------------------------ 合作方
class TestCounterpartyGuards:
    def test_order_counterparty_role_is_constrained_in_database(self, seeded_db):
        order = orders_service.create_order(
            seeded_db, order_type="TH", trade_date=date(2026, 10, 4), actor="pytest"
        )
        counterparty = service.create_counterparty(
            seeded_db, display_name="同行A", type="PEER", actor="pytest"
        )
        seeded_db.add(
            OrderCounterpartyRole(
                order_id=order.id,
                counterparty_id=counterparty.id,
                role="INVALID",
            )
        )
        with pytest.raises(IntegrityError):
            seeded_db.flush()
        seeded_db.rollback()

    def test_empty_display_name_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.create_counterparty(
                seeded_db, display_name="  ", type="PEER", actor="pytest"
            )
        assert "合作方名称必填" in str(exc.value)

    def test_counterparty_active_must_be_boolean_in_service(self, seeded_db):
        peer = service.create_counterparty(
            seeded_db, display_name="布尔状态校验", type="PEER", actor="pytest"
        )
        with pytest.raises(Validation, match="active 必须为布尔值"):
            service.set_counterparty_status(
                seeded_db, peer.id, "false", actor="pytest"
            )
        seeded_db.commit()
        seeded_db.refresh(peer)
        assert peer.status == CounterpartyStatus.ACTIVE.value

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

    def test_counterparty_update_validates_all_fields_before_mutating(self, seeded_db):
        peer = service.create_counterparty(
            seeded_db, display_name="原合作方", type="PEER", actor="pytest"
        )

        with pytest.raises(Validation, match="合作方更新字段不受支持"):
            service.update_counterparty(
                seeded_db,
                peer.id,
                actor="operator",
                display_name="不应保存的新合作方",
                unsupported_field="invalid",
            )

        seeded_db.commit()
        seeded_db.refresh(peer)
        assert peer.display_name == "原合作方"
        assert peer.updated_by == "pytest"


# ------------------------------------------------------------------ 活字段
class TestFieldDefinitionGuards:
    def test_extra_values_require_an_existing_customer(self, seeded_db):
        definition = service.create_field_definition(
            seeded_db,
            entity_type="customer",
            field_key="orphan_guard",
            label="孤儿值校验",
            actor="pytest",
        )
        with pytest.raises(NotFound, match="客户 999999 不存在"):
            service.set_extra_values(
                seeded_db,
                entity_type="customer",
                entity_id=999999,
                values=[(definition.field_key, "不应落库")],
            )

    def test_extra_values_validate_as_a_batch_before_mutating(self, seeded_db):
        text_definition = service.create_field_definition(
            seeded_db,
            entity_type="customer",
            field_key="batch_note",
            label="批量备注",
            actor="pytest",
        )
        number_definition = service.create_field_definition(
            seeded_db,
            entity_type="customer",
            field_key="batch_amount",
            label="批量金额",
            field_type="NUMBER",
            actor="pytest",
        )
        customer = service.create_customer(seeded_db, display_name="批量字段客户", actor="pytest")

        with pytest.raises(Validation, match="字段 批量金额 必须为数字"):
            service.set_extra_values(
                seeded_db,
                entity_type="customer",
                entity_id=customer.id,
                values=[
                    (text_definition.field_key, "应该回滚"),
                    (number_definition.field_key, "不是数字"),
                ],
            )

        seeded_db.commit()
        assert service.get_extra_values(
            seeded_db, entity_type="customer", entity_id=customer.id
        ) == {}

    def test_customer_update_does_not_partially_write_when_extra_value_fails(self, seeded_db):
        definition = service.create_field_definition(
            seeded_db,
            entity_type="customer",
            field_key="update_amount",
            label="更新金额",
            field_type="NUMBER",
            actor="pytest",
        )
        customer = service.create_customer(
            seeded_db, display_name="原客户名称", actor="pytest"
        )

        with pytest.raises(Validation, match="字段 更新金额 必须为数字"):
            service.update_customer(
                seeded_db,
                customer.id,
                actor="operator",
                display_name="不应保存的新名称",
                extra_values={definition.field_key: "不是数字"},
            )

        seeded_db.commit()
        seeded_db.refresh(customer)
        assert customer.display_name == "原客户名称"
        assert customer.updated_by == "pytest"
        assert service.get_extra_values(
            seeded_db, entity_type="customer", entity_id=customer.id
        ) == {}

    def test_customer_creation_does_not_partially_write_when_extra_value_fails(self, seeded_db):
        definition = service.create_field_definition(
            seeded_db,
            entity_type="customer",
            field_key="create_amount",
            label="创建金额",
            field_type="NUMBER",
            actor="pytest",
        )

        with pytest.raises(Validation, match="字段 创建金额 必须为数字"):
            service.create_customer(
                seeded_db,
                display_name="不应落库的客户",
                actor="operator",
                extra_values={definition.field_key: "不是数字"},
            )

        seeded_db.commit()
        assert seeded_db.scalar(
            select(FieldDefinition.id).where(FieldDefinition.id == definition.id)
        ) == definition.id
        assert service.list_customers(seeded_db, keyword="不应落库的客户") == []

    def test_database_rejects_non_customer_extra_value(self, seeded_db):
        definition = service.create_field_definition(
            seeded_db,
            entity_type="customer",
            field_key="database_guard",
            label="数据库校验",
            actor="pytest",
        )
        with pytest.raises(IntegrityError):
            seeded_db.execute(
                EntityExtraValue.__table__.insert().values(
                    entity_type="order",
                    entity_id=1,
                    field_definition_id=definition.id,
                    value={"value": "invalid"},
                )
            )

    @pytest.mark.parametrize("field_type", ["UNKNOWN", "JSON", "number"])
    def test_invalid_field_type_rejected(self, seeded_db, field_type):
        with pytest.raises(Validation) as exc:
            service.create_field_definition(
                seeded_db,
                entity_type="customer",
                field_key="custom_type",
                label="字段",
                field_type=field_type,
                actor="pytest",
            )
        assert "字段类型必须为" in str(exc.value)

    def test_negative_sort_order_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            service.create_field_definition(
                seeded_db,
                entity_type="customer",
                field_key="negative_order",
                label="字段",
                sort_order=-1,
                actor="pytest",
            )
        assert "排序值不能为负数" in str(exc.value)

    def test_field_definition_inputs_are_strictly_typed(self, seeded_db):
        with pytest.raises(Validation, match="实体类型必须为"):
            service.create_field_definition(
                seeded_db, entity_type=123, field_key="typed_entity", label="字段",
                actor="pytest",
            )
        with pytest.raises(Validation, match="字段键必须为小写字母开头"):
            service.create_field_definition(
                seeded_db, entity_type="customer", field_key=123, label="字段",
                actor="pytest",
            )
        with pytest.raises(Validation, match="字段名称不能为空"):
            service.create_field_definition(
                seeded_db, entity_type="customer", field_key="typed_label", label=123,
                actor="pytest",
            )
        with pytest.raises(Validation, match="排序值必须为整数"):
            service.create_field_definition(
                seeded_db, entity_type="customer", field_key="typed_sort", label="字段",
                sort_order="1", actor="pytest",
            )

    def test_database_rejects_invalid_field_definition_values(self, seeded_db):
        with pytest.raises(IntegrityError):
            seeded_db.execute(
                FieldDefinition.__table__.insert().values(
                    entity_type="customer",
                    field_key="invalid_db_type",
                    label="字段",
                    field_type="UNKNOWN",
                    options=[],
                    required=False,
                    sort_order=0,
                    is_active=True,
                    created_by="pytest",
                    updated_by="pytest",
                )
            )

    def test_database_rejects_negative_sort_order(self, seeded_db):
        with pytest.raises(IntegrityError):
            seeded_db.execute(
                FieldDefinition.__table__.insert().values(
                    entity_type="customer",
                    field_key="negative_db_order",
                    label="字段",
                    field_type="TEXT",
                    options=[],
                    required=False,
                    sort_order=-1,
                    is_active=True,
                    created_by="pytest",
                    updated_by="pytest",
                )
            )

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

    @pytest.mark.parametrize("field_type", ["SELECT", "MULTI_SELECT"])
    def test_choice_field_requires_unique_nonempty_options(self, seeded_db, field_type):
        with pytest.raises(Validation) as exc:
            service.create_field_definition(
                seeded_db,
                entity_type="customer",
                field_key="choice_field",
                label="选项字段",
                field_type=field_type,
                actor="pytest",
            )
        assert "选项" in str(exc.value)

        with pytest.raises(Validation):
            service.create_field_definition(
                seeded_db,
                entity_type="customer",
                field_key="choice_field_duplicate",
                label="选项字段",
                field_type=field_type,
                options=["A", "A"],
                actor="pytest",
            )

    def test_choice_field_rejects_blank_or_non_string_options(self, seeded_db):
        with pytest.raises(Validation):
            service.create_field_definition(
                seeded_db,
                entity_type="customer",
                field_key="choice_blank",
                label="选项字段",
                field_type="SELECT",
                options=[""],
                actor="pytest",
            )
        with pytest.raises(Validation):
            service.create_field_definition(
                seeded_db,
                entity_type="customer",
                field_key="choice_number",
                label="选项字段",
                field_type="SELECT",
                options=[1],
                actor="pytest",
            )

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

    def test_field_definition_active_must_be_boolean_in_service(self, seeded_db):
        definition = service.create_field_definition(
            seeded_db,
            entity_type="customer",
            field_key="bool_active",
            label="布尔状态校验",
            actor="pytest",
        )
        with pytest.raises(Validation, match="active 必须为布尔值"):
            service.set_field_definition_active(
                seeded_db, definition.id, "false", actor="pytest"
            )
        seeded_db.commit()
        seeded_db.refresh(definition)
        assert definition.is_active is True

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
        assert response.json()[0]["order_roles"] == []
        assert response.json()[0]["active_order_count"] == 0

    def test_customer_detail_endpoint_returns_four_tabs(self, seeded_client, seeded_db, headers):
        customer = _customer(seeded_db, "详情接口客户", owner_id=9)
        order = orders_service.create_order(
            seeded_db,
            order_type="DFQ",
            trade_date=date(2026, 10, 12),
            customer_roles=[(customer.id, "INSTALLMENT_CUSTOMER")],
            actor="pytest",
        )
        installment_service.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type="ADVANCE_PURCHASE",
            principal=300,
            down_payment=100,
            periods=1,
            per_period=200,
            first_due_on=date(2026, 10, 12),
            actor="pytest",
        )

        response = seeded_client.get(
            f"{CUSTOMERS}/{customer.id}/detail", headers=headers
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert set(body) == {"customer", "overview", "business", "installments", "audit"}
        assert body["customer"]["id"] == customer.id
        assert body["business"][0]["order_no"] == order.order_no
        assert body["installments"][0]["total_receivable"] == "300.00"

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
