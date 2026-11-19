"""PARTY-01 parties 客户/合作方契约测试（CUS-01 / BAS-02-05 / BAS-04）。

与 test_parties.py 的分工：既有文件已覆盖编号域、联系方式原值输出、停用/合并参与方校验、
合并迁移主路径、字段停用保留历史值、以及创建客户/合作方/字段端点；
本文件补建单必填校验、查重空条件、查询三过滤+作用域、
客户更新（含已合并冲突与联系方式审计分流）、状态机 MERGED 守卫、
合并同源/已合并/重复角色去重、合作方查询与更新、字段定义三项校验与停用过滤、
表单扩展字段覆写，以及 7 个未测路由端点。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.shared.audit import record_audit
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
    OrderCounterpartyRole,
    OrderCustomerRole,
)
from app.domain.trade import InstallmentSchedule, OrderFormField
from app.installments import create as inst_create
from app.orders.create import create_order
from app.orders.events import post_event
from app.stocks.profile import create_account
from app.customer_center.counterparties import (
    create_counterparty,
    get_counterparty,
    list_counterparties,
    set_counterparty_status,
    update_counterparty,
)
from app.customer_center.customer_detail import get_customer_activity_summary, get_customer_detail
from app.customer_center.customer_merge import duplicate_candidates, merge_customers
from app.customer_center.customers import create_customer, get_customer, list_customers, set_customer_status, update_customer
from app.shared.form_values import get_extra_values, set_extra_values

CUSTOMERS = "/api/v1/customers"
COUNTERPARTIES = "/api/v1/counterparties"



def _scoped_user() -> CurrentUser:
    """非 admin、SELF 作用域用户（可见集只有自己）。"""
    return CurrentUser.build(
        id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
    )

def _customer(seeded_db, name: str, **kwargs):
    return create_customer(seeded_db, display_name=name, actor="pytest", **kwargs)

def _audit_actions(seeded_db, action: AuditAction) -> list[str]:
    rows = seeded_db.scalars(
        select(AuditLog).where(AuditLog.action == action.value)
    ).all()
    return [row.entity_id for row in rows]

class TestCreateCustomerGuards:
    def test_empty_display_name_rejected(self, seeded_db):
        with pytest.raises(Validation) as exc:
            create_customer(seeded_db, display_name="   ", actor="pytest")
        assert "称呼/昵称必填" in str(exc.value)

    def test_extra_values_require_object_with_string_keys(self, seeded_db):
        with pytest.raises(Validation, match="表单扩展字段值必须为对象"):
            create_customer(
                seeded_db,
                display_name="表单扩展字段结构错误",
                actor="pytest",
                extra_values=["not-an-object"],
            )
        with pytest.raises(Validation, match="表单扩展字段键必须为非空字符串"):
            create_customer(
                seeded_db,
                display_name="表单扩展字段键错误",
                actor="pytest",
                extra_values={1: "value"},
            )

    def test_customer_owner_must_exist(self, seeded_db):
        with pytest.raises(Validation, match="客户负责人不存在"):
            create_customer(
                seeded_db, display_name="负责人校验", actor="pytest", owner_id=999999
            )

    def test_create_names_reject_non_text_values(self, seeded_db):
        with pytest.raises(Validation, match="称呼/昵称必填"):
            create_customer(seeded_db, display_name=123, actor="pytest")
        with pytest.raises(Validation, match="合作方名称必填"):
            create_counterparty(
                seeded_db, display_name=123, type="PEER", actor="pytest"
            )

    def test_duplicate_candidates_without_conditions_returns_empty(self, seeded_db):
        # 150：无任何联系方式入参 → 直接返回空候选，不查库
        assert duplicate_candidates(seeded_db) == []

    def test_duplicate_candidates_reject_non_text_contact_values(self, seeded_db):
        with pytest.raises(Validation, match="联系方式必须为文本"):
            duplicate_candidates(seeded_db, phone=123)

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

class TestListAndGetCustomers:
    def test_list_filters_by_created_by(self, seeded_db):
        mine = create_customer(seeded_db, display_name="创建人甲", actor="alice")
        create_customer(seeded_db, display_name="创建人乙", actor="bob")

        filtered = list_customers(seeded_db, created_by=["alice"])

        assert [customer.id for customer in filtered] == [mine.id]

    def test_list_filters_keyword_status_and_scope(self, seeded_db):
        mine = _customer(seeded_db, "阿甲", phone="13800001111", owner_id=9)
        other = _customer(seeded_db, "阿乙", phone="13900002222", owner_id=1)
        set_customer_status(seeded_db, other.id, "DISABLED", actor="pytest")

        by_status = list_customers(seeded_db, status=CustomerStatus.ACTIVE.value)
        assert [c.id for c in by_status] == [mine.id]

        by_name = list_customers(seeded_db, keyword="阿甲")
        assert [c.id for c in by_name] == [mine.id]
        # 关键词同时匹配客户编号/手机/微信/QQ
        by_phone = list_customers(seeded_db, keyword="13800001111")
        assert [c.id for c in by_phone] == [mine.id]

        scoped = list_customers(seeded_db, user=_scoped_user())
        assert [c.id for c in scoped] == [mine.id]
        assert other.id not in [c.id for c in scoped]

    def test_customer_list_activity_summary_comes_from_order_relations(self, seeded_db):
        customer = _customer(seeded_db, "列表汇总客户", owner_id=9)
        order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=date(2026, 10, 12),
            customer_roles=[
                (customer.id, "SELLER"),
                (customer.id, "BUYER"),
            ],
            actor="pytest",
        )

        summary = get_customer_activity_summary(seeded_db, [customer.id])

        assert summary[customer.id]["order_roles"] == ["BUYER", "SELLER"]
        assert summary[customer.id]["active_order_count"] == 1
        assert summary[customer.id]["last_interaction_at"] == order.created_at

    def test_get_customer_notfound_and_scope_forbidden(self, seeded_db):
        with pytest.raises(NotFound):
            get_customer(seeded_db, 999999)
        # 他人 owner 的客户对 SELF 作用域同样 404（不泄露存在性）
        other = _customer(seeded_db, "阿丙", owner_id=1)
        with pytest.raises(NotFound):
            get_customer(seeded_db, other.id, _scoped_user())

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
        dg_order = create_order(
            seeded_db,
            order_type="DG",
            trade_date=date(2026, 10, 10),
            customer_roles=[(customer.id, "CONSIGNOR")],
            actor="pytest",
        )
        th = create_order(
            seeded_db,
            order_type="TH",
            trade_date=date(2026, 10, 11),
            customer_roles=[(customer.id, "BUYER")],
            actor="pytest",
        )
        installment = inst_create.create_installment(
            seeded_db,
            order_id=th.id,
            contract_type="PICKUP_SALE",
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

        detail = get_customer_detail(seeded_db, customer.id)

        assert detail["overview"]["order_count"] == 2
        assert detail["overview"]["active_order_count"] == 2
        assert detail["overview"]["last_trade_date"] == date(2026, 10, 11)
        assert detail["overview"]["installment_paid_total"] == 0
        assert detail["overview"]["installment_receivable_total"] == 500
        assert detail["overview"]["overdue_period_count"] == 1
        assert {item["order_no"] for item in detail["business"]} == {
            dg_order.order_no, th.order_no,
        }
        assert detail["business"][0]["roles"]
        assert detail["installments"][0]["inst_no"] == installment.inst_no
        assert detail["installments"][0]["remaining_amount"] == 500
        assert any(item["action"] == AuditAction.CUSTOMER_CREATE.value for item in detail["audit"])
        assert any(item["request_id"] == request_id for item in detail["audit"])

    def test_customer_detail_includes_cumulative_profit(self, seeded_db):
        customer = _customer(seeded_db, "利润客户")
        profitable_account = create_account(
            seeded_db, game_account="customer-profit-account", business_mode="SELF",
            inventory_type="RECOVERY", actor="pytest",
        )
        loss_account = create_account(
            seeded_db, game_account="customer-loss-account", business_mode="SELF",
            inventory_type="RECOVERY", actor="pytest",
        )
        profitable = create_order(
            seeded_db,
            order_type="HS",
            trade_date=date(2026, 10, 10),
            customer_roles=[(customer.id, "BUYER")],
            actor="pytest",
            account_id=profitable_account.id,
        )
        loss = create_order(
            seeded_db,
            order_type="HS",
            trade_date=date(2026, 10, 11),
            customer_roles=[(customer.id, "BUYER")],
            actor="pytest",
            account_id=loss_account.id,
        )
        post_event(seeded_db, profitable.id, event_type="BUY", amount=100, occurred_on=date(2026, 10, 10), actor="pytest", pool_id=1)
        post_event(seeded_db, profitable.id, event_type="SELL", amount=400, occurred_on=date(2026, 10, 10), actor="pytest", pool_id=1)
        post_event(seeded_db, loss.id, event_type="BUY", amount=200, occurred_on=date(2026, 10, 11), actor="pytest", pool_id=1)
        post_event(seeded_db, loss.id, event_type="SELL", amount=150, occurred_on=date(2026, 10, 11), actor="pytest", pool_id=1)

        detail = get_customer_detail(seeded_db, customer.id)

        assert detail["overview"]["cumulative_profit"] == 250

    def test_counterparty_detail_includes_order_summary_profit_and_order_rows(self, seeded_client, seeded_db):
        counterparty = seeded_client.post(
            COUNTERPARTIES,
            json={"display_name": "成单同行", "type": "PEER"},
            headers={"X-Dev-User": "admin"},
        ).json()
        order = create_order(
            seeded_db,
            order_type="TH",
            trade_date=date(2026, 10, 18),
            counterparty_roles=[(counterparty["id"], "PEER")],
            actor="pytest",
        )
        post_event(
            seeded_db, order.id, event_type="BUY", amount=100, occurred_on=date(2026, 10, 18), actor="pytest", pool_id=1
        )
        post_event(
            seeded_db, order.id, event_type="SELL", amount=450, occurred_on=date(2026, 10, 18), actor="pytest", pool_id=1
        )

        response = seeded_client.get(
            f"{COUNTERPARTIES}/{counterparty['id']}", headers={"X-Dev-User": "employee"}
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["overview"]["order_count"] == 1
        assert body["overview"]["completed_order_count"] == 1
        assert body["overview"]["cumulative_profit"] == "350.00"
        assert body["orders"][0]["order_no"] == order.order_no
        assert body["orders"][0]["roles"] == ["PEER"]
        assert body["orders"][0]["profit"] == "350.00"

    def test_customer_detail_applies_order_owner_scope(self, seeded_db):
        customer = _customer(seeded_db, "范围客户", owner_id=9)
        mine = create_order(
            seeded_db,
            order_type="HS",
            trade_date=date(2026, 10, 10),
            owner_id=9,
            customer_roles=[(customer.id, "BUYER")],
            actor="pytest",
        )
        foreign = create_order(
            seeded_db,
            order_type="TH",
            trade_date=date(2026, 10, 11),
            owner_id=1,
            customer_roles=[(customer.id, "BUYER")],
            actor="pytest",
        )

        detail = get_customer_detail(seeded_db, customer.id, _scoped_user())
        summary = get_customer_activity_summary(
            seeded_db, [customer.id], _scoped_user()
        )

        assert {item["order_id"] for item in detail["business"]} == {mine.id}
        assert summary[customer.id]["active_order_count"] == 1
        assert foreign.id not in {item["order_id"] for item in detail["business"]}

class TestUpdateCustomer:
    def test_customer_update_validates_all_fields_before_mutating(self, seeded_db):
        customer = _customer(seeded_db, "原客户")

        with pytest.raises(Validation, match="客户更新字段不受支持"):
            update_customer(
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
            update_customer(
                seeded_db, customer.id, actor="pytest", display_name="   "
            )

        counterparty = create_counterparty(
            seeded_db, display_name="合作方名", type="PEER", actor="pytest"
        )
        with pytest.raises(Validation, match="合作方名称不能清空"):
            update_counterparty(
                seeded_db, counterparty.id, actor="pytest", display_name="   "
            )

    def test_customer_mutations_respect_owner_scope(self, seeded_db):
        other = _customer(seeded_db, "他人客户", owner_id=1)

        with pytest.raises(NotFound):
            update_customer(
                seeded_db,
                other.id,
                actor="operator",
                user=_scoped_user(),
                note="越权修改",
            )
        with pytest.raises(NotFound):
            set_customer_status(
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
        merge_customers(
            seeded_db,
            source_customer_id=source.id,
            target_customer_id=target.id,
            reason="同一微信",
            actor="admin",
        )
        with pytest.raises(Conflict) as exc:
            update_customer(seeded_db, source.id, actor="pytest", note="x")
        assert "已合并客户不可修改" in str(exc.value)

        with pytest.raises(Validation, match="已合并客户不可修改状态"):
            set_customer_status(
                seeded_db, source.id, CustomerStatus.ACTIVE.value, actor="pytest"
            )

    def test_contact_change_writes_contact_audit(self, seeded_db):
        customer = _customer(seeded_db, "阿甲", phone="13800001111")
        update_customer(
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
        update_customer(seeded_db, customer.id, actor="pytest", source="转介绍")
        assert customer.source == "转介绍"
        assert _audit_actions(seeded_db, AuditAction.CUSTOMER_UPDATE) == [
            customer.customer_no
        ]
        assert _audit_actions(seeded_db, AuditAction.CONTACT_WRITE) == []

    def test_status_cannot_be_set_to_merged_manually(self, seeded_db):
        customer = _customer(seeded_db, "阿甲")
        with pytest.raises(Validation) as exc:
            set_customer_status(
                seeded_db, customer.id, CustomerStatus.MERGED.value, actor="pytest"
            )
        assert "MERGED 只能由合并动作产生" in str(exc.value)

    def test_status_rejects_unknown_value_in_service(self, seeded_db):
        customer = _customer(seeded_db, "阿甲")
        with pytest.raises(Validation) as exc:
            set_customer_status(
                seeded_db, customer.id, "PENDING", actor="pytest"
            )
        assert "客户状态无效" in str(exc.value)

class TestMergeGuards:
    def test_merge_requires_non_blank_reason(self, seeded_db):
        source = _customer(seeded_db, "源")
        target = _customer(seeded_db, "目标")
        with pytest.raises(Validation, match="客户合并必须填写原因"):
            merge_customers(
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
            merge_customers(
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
            merge_customers(
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
        merge_customers(
            seeded_db,
            source_customer_id=source.id,
            target_customer_id=target.id,
            reason="重复建档",
            actor="admin",
        )
        with pytest.raises(Validation) as exc:
            merge_customers(
                seeded_db,
                source_customer_id=source.id,
                target_customer_id=third.id,
                reason="再合一次",
                actor="admin",
            )
        assert "来源客户已合并" in str(exc.value)

    def test_duplicate_role_is_dropped_on_merge(self, seeded_db):
        order = create_order(
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

        merge_customers(
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
        seeded_db.add(
            OrderFormField(
                order_type_code="CUSTOMER", field_key="preferred_platform",
                label="常用平台", field_type="TEXT", is_custom=True,
                created_by="pytest", updated_by="pytest",
            )
        )
        seeded_db.flush()
        definition = seeded_db.scalar(
            select(OrderFormField).where(OrderFormField.field_key == "preferred_platform")
        )
        source = _customer(seeded_db, "带表单扩展字段的源")
        target = _customer(seeded_db, "没有表单扩展字段的目标")
        set_extra_values(
            seeded_db,
            entity_type="customer",
            entity_id=source.id,
            values=[(definition.field_key, "王者荣耀")],
        )

        merge_customers(
            seeded_db,
            source_customer_id=source.id,
            target_customer_id=target.id,
            reason="资料合并",
            actor="admin",
        )

        assert get_extra_values(
            seeded_db, entity_type="customer", entity_id=target.id
        ) == {"preferred_platform": "王者荣耀"}
        assert get_extra_values(
            seeded_db, entity_type="customer", entity_id=source.id
        ) == {"preferred_platform": "王者荣耀"}


class TestCustomerDetailRemaining:
    """客户详情「剩余应收」口径：与分期域 remaining_receivable 同源。"""

    @staticmethod
    def _installment(seeded_db, customer, *, paid, waived=0, bad_debt=0):
        order = create_order(
            seeded_db,
            order_type="TH",
            trade_date=date(2026, 11, 10),
            customer_roles=[(customer.id, "BUYER")],
            actor="pytest",
        )
        inst = inst_create.create_installment(
            seeded_db,
            order_id=order.id,
            contract_type="PICKUP_SALE",
            principal=1200,
            down_payment=200,
            periods=1,
            per_period=1000,
            first_due_on=date(2026, 11, 15),
            actor="pytest",
        )
        inst.paid_amount = Decimal(paid)
        inst.waived_amount = Decimal(waived)
        inst.bad_debt_amount = Decimal(bad_debt)
        seeded_db.flush()
        return inst

    def test_customer_detail_remaining_clamps_after_waiver(self, seeded_db):
        """先收后减免：合约级与汇总级都夹底 0，不出现负数。"""
        customer = _customer(seeded_db, "减免客户")
        # 总应收 700（1200−减免500），已收 900 → 权威 0，裸减法 −200
        self._installment(seeded_db, customer, paid="900", waived="500")

        detail = get_customer_detail(seeded_db, customer.id)

        assert detail["installments"][0]["remaining_amount"] == Decimal("0.00")
        assert detail["overview"]["installment_remaining_total"] == Decimal("0.00")

    def test_customer_detail_remaining_subtracts_bad_debt(self, seeded_db):
        """坏账场景：合约级与汇总级都减坏账，不多算。"""
        customer = _customer(seeded_db, "坏账客户")
        # 总应收 1200，已收 300，坏账 100 → 权威 800，裸减法 900
        self._installment(seeded_db, customer, paid="300", bad_debt="100")

        detail = get_customer_detail(seeded_db, customer.id)

        assert detail["installments"][0]["remaining_amount"] == Decimal("800.00")
        assert detail["overview"]["installment_remaining_total"] == Decimal("800.00")

    def test_customer_detail_remaining_sums_clamped_per_contract(self, seeded_db):
        """多合约：逐合约夹底后求和（对齐 totals），不先汇总再夹底。"""
        customer = _customer(seeded_db, "多合约客户")
        # 合约 A：总应收 1200，已收 1300 → 夹底 0
        self._installment(seeded_db, customer, paid="1300")
        # 合约 B：总应收 1200，已收 300，坏账 100 → 800
        self._installment(seeded_db, customer, paid="300", bad_debt="100")

        detail = get_customer_detail(seeded_db, customer.id)

        remaining = sorted(
            item["remaining_amount"] for item in detail["installments"]
        )
        assert remaining == [Decimal("0.00"), Decimal("800.00")]
        assert detail["overview"]["installment_remaining_total"] == Decimal("800.00")
