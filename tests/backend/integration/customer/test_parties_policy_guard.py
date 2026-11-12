"""PARTY-01 parties / policy service 守门用例（批3 覆盖收口）。

直接驱动业务校验/守卫分支，把 parties.service 与 policy.service 推到 100%。
源码级死代码（policy.set_allocations 的 rate 解析/负数、重复人员、不完整分配项）
已在前置提交中移除；本文件只覆盖可达分支。
"""

from datetime import date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import Conflict, NotFound, Validation
from app.core.security import CurrentUser
from app.domain.parties import (
    CustomerLead,
    OrderCustomerRole,
)
from app.domain.trade import Order, OrderEvent
from app.domain.users import User
from app.orders.create import create_order
from app.parties.customer_detail import get_customer_activity_summary
from app.parties.customer_merge import merge_customers
from app.parties.customers import create_customer
from app.parties.leads import close_lead, convert_lead, create_lead, get_lead, list_leads, update_lead
from app.policy.profit_allocation import service as policy_allocations
from app.policy import definitions as policy_definitions
from app.policy import versions as policy_versions


# ───────────────────────────── 共用辅助 ─────────────────────────────

def _customer(session, **kwargs):
    return create_customer(
        session, display_name=kwargs.pop("display_name", "守门客户"), actor="pytest", **kwargs
    )


def _non_admin_user(session):
    """造一个非管理员、owner_scope=SELF 的占位用户（供范围过滤分支）。"""
    user = User(
        username="guarduser1",
        display_name="守门用户",
        password_hash="not-real",
        role="VIEWER",
        owner_scope="SELF",
        pool_ids=[],
        team_ids=[],
        is_active=True,
    )
    session.add(user)
    session.flush()
    return user


def _scoped_user(user: User) -> CurrentUser:
    return CurrentUser.build(
        id=user.id,
        username=user.username,
        roles=("VIEWER",),
        owner_scope="SELF",
        pool_ids=frozenset(),
    )


def _order(session):
    return create_order(
        session, order_type="HS", trade_date=date.today(), actor="pytest"
    )


def _add_buy_event(session, order, *, created_by="seeduser1"):
    session.add(
        OrderEvent(
            event_no=f"EV-G{order.id}-{created_by}",
            order_id=order.id,
            event_type="BUY",
            amount=Decimal("100"),
            occurred_on=date.today(),
            is_posted=True,
            created_at=datetime.now(),
            created_by=created_by,
            updated_by=created_by,
        )
    )
    session.flush()


# ───────────────────────────── parties.service ─────────────────────────────

class TestPartiesActivitySummary:
    def test_empty_ids_returns_empty(self, seeded_db):
        # 249: not ids -> 直接返回空 summary
        assert get_customer_activity_summary(seeded_db, []) == {}

    def test_event_last_interaction(self, seeded_db):
        # 285/289: 事件时间线回写 last_interaction_at
        cust = _customer(seeded_db)
        seeded_db.add(
            Order(
                id=1, order_no="ORD0001", order_type="HS", capital_type="STOCK",
                trade_date=date.today(), status="ACTIVE", link_status="UNLINKED",
                created_by="pytest", updated_by="pytest",
                created_at=datetime.now(), updated_at=datetime.now(),
            )
        )
        seeded_db.flush()
        seeded_db.add(OrderCustomerRole(order_id=1, customer_id=cust.id, role="BUYER"))
        seeded_db.add(
            OrderEvent(
                event_no="EV-SUM1", order_id=1, event_type="BUY", amount=100,
                occurred_on=date.today(), is_posted=True, created_at=datetime.now(),
                created_by="seeduser1", updated_by="seeduser1",
            )
        )
        seeded_db.flush()
        result = get_customer_activity_summary(seeded_db, [cust.id])
        assert result[cust.id]["last_interaction_at"] is not None


class TestPartiesMerge:
    def test_merge_reassigns_leads(self, seeded_db):
        # 632/633: 来源客户的客户需求迁移到目标
        source = _customer(seeded_db)
        target = _customer(seeded_db)
        seeded_db.commit()
        create_lead(
            seeded_db, customer_id=source.id, request_type="FIND_ACCOUNT",
            target="找号", actor="pytest",
        )
        seeded_db.commit()
        merge_customers(
            seeded_db, source_customer_id=source.id, target_customer_id=target.id,
            reason="重复建档", actor="admin",
        )
        migrated = seeded_db.scalars(
            select(CustomerLead).where(CustomerLead.customer_id == target.id)
        ).all()
        assert len(migrated) == 1

    def test_merge_skips_existing_extra(self, seeded_db):
        # 654: 目标已存在同字段扩展值时跳过（保留目标值）
        source = _customer(seeded_db)
        target = _customer(seeded_db)
        seeded_db.commit()
        source.form_extra = {"k1": "来源值"}
        target.form_extra = {"k1": "目标值"}
        seeded_db.commit()
        # 不应抛错；来源仍被标记为 MERGED
        merge_customers(
            seeded_db, source_customer_id=source.id, target_customer_id=target.id,
            reason="重复建档", actor="admin",
        )
        assert source.status == "MERGED"


class TestPartiesLeadGuards:
    def test_get_lead_missing(self, seeded_db):
        # 697: 需求不存在 -> NotFound
        with pytest.raises(NotFound):
            get_lead(seeded_db, 99999)

    def test_get_lead_scope_excludes(self, seeded_db):
        # 703: 非管理员且 owner 不在可见范围 -> NotFound
        user = _non_admin_user(seeded_db)
        lead = create_lead(
            seeded_db, customer_id=_customer(seeded_db).id, request_type="FIND_ACCOUNT",
            target="x", actor="pytest",
        )
        seeded_db.commit()
        scoped = _scoped_user(user)
        with pytest.raises(NotFound):
            get_lead(seeded_db, lead.id, user=scoped)

    def test_create_lead_invalid_type(self, seeded_db):
        # 729/730: 非法 request_type -> Validation
        cust = _customer(seeded_db)
        with pytest.raises(Validation):
            create_lead(
                seeded_db, customer_id=cust.id, request_type="BADTYPE",
                target="x", actor="pytest",
            )

    def test_create_lead_negative_budget(self, seeded_db):
        # 736: 预算为负 -> Validation
        cust = _customer(seeded_db)
        with pytest.raises(Validation):
            create_lead(
                seeded_db, customer_id=cust.id, request_type="FIND_ACCOUNT",
                target="x", budget=Decimal("-1"), actor="pytest",
            )

    def test_list_leads_invalid_status(self, seeded_db):
        # 784/785: 非法 status -> Validation
        with pytest.raises(Validation):
            list_leads(seeded_db, status="BADSTATUS")

    def test_list_leads_keyword(self, seeded_db):
        # 791/792: 关键字过滤分支
        create_lead(
            seeded_db, customer_id=_customer(seeded_db).id, request_type="FIND_ACCOUNT",
            target="守门专用目标", actor="pytest",
        )
        seeded_db.commit()
        rows = list_leads(seeded_db, keyword="守门专用")
        assert any("守门专用" in r.target for r in rows)

    def test_list_leads_scope(self, seeded_db):
        # 801: 非管理员用户触发范围过滤
        user = _non_admin_user(seeded_db)
        scoped = _scoped_user(user)
        rows = list_leads(seeded_db, user=scoped)
        assert isinstance(rows, list)

    def test_update_lead_not_open(self, seeded_db):
        # 816: 非 OPEN 需求不可编辑 -> Conflict
        cust = _customer(seeded_db)
        lead = create_lead(
            seeded_db, customer_id=cust.id, request_type="FIND_ACCOUNT",
            target="x", actor="pytest",
        )
        seeded_db.commit()
        close_lead(seeded_db, lead.id, reason="关闭", actor="pytest")
        seeded_db.commit()
        with pytest.raises(Conflict):
            update_lead(seeded_db, lead.id, actor="pytest", note="改")

    def test_update_lead_unknown_field(self, seeded_db):
        # 820: 不支持的更新字段 -> Validation
        cust = _customer(seeded_db)
        lead = create_lead(
            seeded_db, customer_id=cust.id, request_type="FIND_ACCOUNT",
            target="x", actor="pytest",
        )
        seeded_db.commit()
        with pytest.raises(Validation):
            update_lead(seeded_db, lead.id, actor="pytest", bogus="y")

    def test_update_lead_negative_budget(self, seeded_db):
        # 836: 更新预算为负 -> Validation
        cust = _customer(seeded_db)
        lead = create_lead(
            seeded_db, customer_id=cust.id, request_type="FIND_ACCOUNT",
            target="x", actor="pytest",
        )
        seeded_db.commit()
        with pytest.raises(Validation):
            update_lead(
                seeded_db, lead.id, actor="pytest", budget=Decimal("-1")
            )

    def test_update_lead_invalid_owner(self, seeded_db):
        # 838: owner_id 非法 -> _validate_owner_id -> Validation
        cust = _customer(seeded_db)
        lead = create_lead(
            seeded_db, customer_id=cust.id, request_type="FIND_ACCOUNT",
            target="x", actor="pytest",
        )
        seeded_db.commit()
        with pytest.raises(Validation):
            update_lead(seeded_db, lead.id, actor="pytest", owner_id=-1)

    def test_convert_lead_not_open(self, seeded_db):
        # 883: 非 OPEN 需求不可转单 -> Conflict
        cust = _customer(seeded_db)
        lead = create_lead(
            seeded_db, customer_id=cust.id, request_type="FIND_ACCOUNT",
            target="x", actor="pytest",
        )
        seeded_db.commit()
        close_lead(seeded_db, lead.id, reason="关闭", actor="pytest")
        seeded_db.commit()
        with pytest.raises(Conflict):
            convert_lead(
                seeded_db, lead.id, order_id=1, actor="pytest"
            )

    def test_convert_lead_order_missing(self, seeded_db):
        # 886: 订单不存在 -> NotFound
        cust = _customer(seeded_db)
        lead = create_lead(
            seeded_db, customer_id=cust.id, request_type="FIND_ACCOUNT",
            target="x", actor="pytest",
        )
        seeded_db.commit()
        with pytest.raises(NotFound):
            convert_lead(
                seeded_db, lead.id, order_id=99999, actor="pytest"
            )

    def test_convert_lead_order_scope_excludes(self, seeded_db):
        # 891: 订单不在用户可见范围 -> NotFound
        user = _non_admin_user(seeded_db)
        scoped = _scoped_user(user)
        cust = _customer(seeded_db)
        lead = create_lead(
            seeded_db, customer_id=cust.id, request_type="FIND_ACCOUNT",
            target="x", actor="pytest", owner_id=user.id,
        )
        order = _order(seeded_db)  # owner_id 默认 None -> 不被 SELF 用户可见
        seeded_db.commit()
        with pytest.raises(NotFound):
            convert_lead(
                seeded_db, lead.id, order_id=order.id, actor="pytest", user=scoped
            )

    def test_close_lead_not_open(self, seeded_db):
        # 917: 非 OPEN 需求不可关闭 -> Conflict
        cust = _customer(seeded_db)
        lead = create_lead(
            seeded_db, customer_id=cust.id, request_type="FIND_ACCOUNT",
            target="x", actor="pytest",
        )
        seeded_db.commit()
        close_lead(seeded_db, lead.id, reason="关闭", actor="pytest")
        seeded_db.commit()
        with pytest.raises(Conflict):
            close_lead(seeded_db, lead.id, reason="再关闭", actor="pytest")


# ───────────────────────────── policy.service ─────────────────────────────

class TestPolicyDefinitionGuards:
    def test_create_definition_global_with_scope_id(self, seeded_db):
        # 146: GLOBAL 范围不能指定 scope_id
        with pytest.raises(Validation):
            policy_definitions.create_definition(
                seeded_db, policy_code="X1", name="X1", scope_type="GLOBAL",
                scope_id=1, actor="pytest",
            )

    def test_create_definition_target_missing(self, seeded_db):
        # 163: 关联对象不存在
        with pytest.raises(Validation):
            policy_definitions.create_definition(
                seeded_db, policy_code="X2", name="X2", scope_type="ORDER_TYPE",
                scope_id=99999, actor="pytest",
            )


class TestPolicyResolveVersionGuards:
    def test_invalid_scope_type(self, seeded_db):
        # 397: scope_type 非法
        with pytest.raises(Validation):
            policy_versions.resolve_version(
                seeded_db, policy_code="X", on=date.today(), scope_type="BAD"
            )

    def test_global_with_scope_id(self, seeded_db):
        # 403: GLOBAL 范围不能指定 scope_id
        with pytest.raises(Validation):
            policy_versions.resolve_version(
                seeded_db, policy_code="X", on=date.today(),
                scope_type="GLOBAL", scope_id=1,
            )

    def test_scoped_requires_scope_id(self, seeded_db):
        # 407: 非 GLOBAL 必须指定 scope_id
        with pytest.raises(Validation):
            policy_versions.resolve_version(
                seeded_db, policy_code="X", on=date.today(), scope_type="ORDER_TYPE"
            )


class TestPolicyAllocationGuards:
    def test_buy_actor_not_found(self, seeded_db):
        # 543: BUY 动作执行人不是用户 -> 无法绑定收益人
        order = _order(seeded_db)
        _add_buy_event(seeded_db, order, created_by="ghostuser")
        seeded_db.commit()
        items = [
            {"allocation_type": "BUY", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "SELL", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "OPERATION", "user_id": 1, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "COMPANY", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
        ]
        with pytest.raises(Validation, match="动作执行人不存在"):
            policy_allocations.set_allocations(seeded_db, order.id, items=items, actor="pytest")

    def test_sell_actor_not_found(self, seeded_db):
        # 553: 售出动作执行人不是用户 -> 无法绑定收益人
        from app.domain.trade import Installment

        order = _order(seeded_db)
        seeded_db.add(
            Installment(
                inst_no="INST-GUARD1", order_id=order.id, contract_type="STOCK_SALE",
                principal=Decimal("100"), down_payment=Decimal("0"),
                service_fee=Decimal("0"), periods=1, per_period_service_fee=Decimal("0"),
                per_period=Decimal("100"), final_period_adjustment=Decimal("0"),
                paid_amount=Decimal("0"), waived_amount=Decimal("0"),
                bad_debt_amount=Decimal("0"), status="PENDING",
                first_due_on=date.today(), created_by="ghostuser", updated_by="ghostuser",
            )
        )
        seeded_db.commit()
        items = [
            {"allocation_type": "BUY", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "SELL", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "OPERATION", "user_id": 1, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "COMPANY", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
        ]
        with pytest.raises(Validation, match="售出动作执行人不存在"):
            policy_allocations.set_allocations(seeded_db, order.id, items=items, actor="pytest")

    def test_invalid_allocation_type(self, seeded_db):
        # 581: 分配项类型非法
        order = _order(seeded_db)
        items = [
            {"allocation_type": "BUY", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "SELL", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "OPERATION", "user_id": 1, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "BAD", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
        ]
        with pytest.raises(Validation, match="分配项必须为"):
            policy_allocations.set_allocations(seeded_db, order.id, items=items, actor="pytest")

    def test_duplicate_allocation_type(self, seeded_db):
        # 583 → 2026-11-05 新口径：一个动作多人时按人数各录一行、份额均分，
        # 「项类型」允许重复；判重改为 (allocation_type, user_id)，同一动作同一人员不可重复。
        # 构造四类齐全 + BUY 两行，但两行的 user_id 都为空 → 应命中按人判重。
        order = _order(seeded_db)
        items = [
            {"allocation_type": "BUY", "user_id": None, "role": "OWNER", "allocation_rate": "20"},
            {"allocation_type": "BUY", "user_id": None, "role": "SALES", "allocation_rate": "20"},
            {"allocation_type": "SELL", "user_id": None, "role": "OWNER", "allocation_rate": "20"},
            {"allocation_type": "OPERATION", "user_id": 1, "role": "OWNER", "allocation_rate": "20"},
            {"allocation_type": "COMPANY", "user_id": None, "role": "OWNER", "allocation_rate": "20"},
        ]
        with pytest.raises(Validation, match="同一动作下同一人员不可重复分润"):
            policy_allocations.set_allocations(seeded_db, order.id, items=items, actor="pytest")

    def test_company_with_user_rejected(self, seeded_db):
        # 586: 公司收益不绑定人员
        order = _order(seeded_db)
        items = [
            {"allocation_type": "BUY", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "SELL", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "OPERATION", "user_id": 1, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "COMPANY", "user_id": 1, "role": "OWNER", "allocation_rate": "25"},
        ]
        with pytest.raises(Validation, match="公司收益不绑定人员"):
            policy_allocations.set_allocations(seeded_db, order.id, items=items, actor="pytest")

    def test_operation_without_user_rejected(self, seeded_db):
        # 588: 人员收益必须绑定人员
        order = _order(seeded_db)
        items = [
            {"allocation_type": "BUY", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "SELL", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "OPERATION", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "COMPANY", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
        ]
        with pytest.raises(Validation, match="人员收益必须绑定人员"):
            policy_allocations.set_allocations(seeded_db, order.id, items=items, actor="pytest")

    def test_buy_recipient_mismatch(self, seeded_db):
        # 594: 买号收益人必须绑定对应动作执行人
        order = _order(seeded_db)
        _add_buy_event(seeded_db, order, created_by="seeduser1")  # 执行人 = 用户 1
        seeded_db.commit()
        items = [
            {"allocation_type": "BUY", "user_id": 2, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "SELL", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "OPERATION", "user_id": 1, "role": "OWNER", "allocation_rate": "25"},
            {"allocation_type": "COMPANY", "user_id": None, "role": "OWNER", "allocation_rate": "25"},
        ]
        with pytest.raises(Validation, match="收益人必须绑定对应动作执行人"):
            policy_allocations.set_allocations(seeded_db, order.id, items=items, actor="pytest")

    def test_total_must_be_100(self, seeded_db):
        # 624: 有效分配比例合计必须为 100%
        order = _order(seeded_db)
        items = [
            {"allocation_type": "BUY", "user_id": None, "role": "OWNER", "allocation_rate": "30"},
            {"allocation_type": "SELL", "user_id": None, "role": "OWNER", "allocation_rate": "30"},
            {"allocation_type": "OPERATION", "user_id": 1, "role": "OWNER", "allocation_rate": "30"},
            {"allocation_type": "COMPANY", "user_id": None, "role": "OWNER", "allocation_rate": "30"},
        ]
        with pytest.raises(Validation, match="100%"):
            policy_allocations.set_allocations(seeded_db, order.id, items=items, actor="pytest")
