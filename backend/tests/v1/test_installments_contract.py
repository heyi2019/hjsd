"""installments 分期合约契约测试（ACC-01 / HS-01-06 / DFQ-01）。

与 test_m2.py / test_bughunt.py 的分工：既有文件已覆盖 DFQ 代分期全流程、
HS 分期出售不新增 BUY、超收校验、未结清不可交付、逾期标记主路径；
本文件补建单校验分支（类型/账号/重复/期数/交付方式）、查询与过滤、
收款守卫（DELIVERED 冲突/期次不存在/自动选期/收满防御）、交付守卫
（非法交付方式/空凭证）、逾期升级 ACTIVE→OVERDUE，以及 3 个未测路由端点。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.security import CurrentUser, build_access_token
from app.domain.enums import (
    AuditAction,
    DeliveryMode,
    InstallmentContractType,
    InstallmentStatus,
    ScheduleStatus,
)
from app.domain.foundation import AuditLog
from app.domain.trade import Installment, InstallmentSchedule, Order
from app.installments import service as installment_service
from app.orders import service as orders_service

TODAY = date(2026, 10, 12)
PAST = date(2026, 9, 1)


def _account(seeded_db, game_account: str):
    from app.accounts import service as accounts_service

    return accounts_service.create_account(
        seeded_db, game_account=game_account, platform="王者", actor="pytest"
    )


def _order(seeded_db, *, order_type="DFQ", account_id=None, owner_id=None, trade_date=TODAY):
    return orders_service.create_order(
        seeded_db, order_type=order_type, trade_date=trade_date, actor="pytest",
        account_id=account_id, owner_id=owner_id,
    )


def _buy(seeded_db, order_id: int, amount="800"):
    orders_service.post_event(
        seeded_db, order_id, event_type="BUY", amount=Decimal(amount),
        occurred_on=TODAY, actor="pytest",
    )


def _contract(
    seeded_db,
    order_id: int,
    *,
    contract_type=InstallmentContractType.ADVANCE_PURCHASE.value,
    down_payment="100",
    periods=2,
    per_period="300",
    first_due_on=TODAY,
    **kwargs,
) -> Installment:
    return installment_service.create_installment(
        seeded_db,
        order_id=order_id,
        contract_type=contract_type,
        principal=Decimal("700"),
        down_payment=Decimal(down_payment),
        periods=periods,
        per_period=Decimal(per_period),
        first_due_on=first_due_on,
        actor="pytest",
        **kwargs,
    )


# ------------------------------------------------------------------ 建单校验
class TestCreateInstallmentValidation:
    def test_negative_amount_is_rejected_before_flush(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation, match="不能为负数"):
            _contract(seeded_db, order.id, down_payment="-1")

    def test_invalid_contract_type_rejected(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation) as exc:
            _contract(seeded_db, order.id, contract_type="ZZ")
        assert "合约类型" in str(exc.value)

    def test_stock_sale_requires_in_stock_account(self, seeded_db):
        # HS 订单已建但未 BUY：账号虽然已在库，但缺少买入事件 → 拒绝
        account = _account(seeded_db, "inst-pending-acc")
        order = _order(seeded_db, order_type="HS", account_id=account.id)
        with pytest.raises(Validation) as exc:
            _contract(
                seeded_db, order.id,
                contract_type=InstallmentContractType.STOCK_SALE.value,
            )
        assert "已在库" in str(exc.value)

    def test_advance_purchase_does_not_require_account(self, seeded_db):
        # DFQ 是独立分销代分期，不关联库存账号。
        order = _order(seeded_db, order_type="DFQ", account_id=None)
        installment = _contract(seeded_db, order.id)
        assert order.account_id is None

    def test_duplicate_contract_conflicts(self, seeded_db):
        order = _order(seeded_db)
        _contract(seeded_db, order.id)
        with pytest.raises(Conflict) as exc:
            _contract(seeded_db, order.id)
        assert "已存在分期合约" in str(exc.value)

    def test_periods_must_be_positive(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation) as exc:
            _contract(seeded_db, order.id, periods=0)
        assert "期数必须大于 0" in str(exc.value)

    def test_invalid_delivery_mode_rejected(self, seeded_db):
        order = _order(seeded_db)
        with pytest.raises(Validation) as exc:
            _contract(seeded_db, order.id, delivery_mode="BOGUS")
        assert "交付方式" in str(exc.value)

    def test_cancelled_order_cannot_create_contract(self, seeded_db):
        order = _order(seeded_db)
        order.status = "CANCELLED"
        seeded_db.flush()

        with pytest.raises(Conflict) as exc:
            _contract(seeded_db, order.id)

        assert exc.value.code == ErrorCode.ORDER_STATUS_CONFLICT


# ------------------------------------------------------------------ 查询与过滤
class TestGetAndListInstallments:
    def test_get_installment_notfound(self, seeded_db):
        with pytest.raises(NotFound):
            installment_service.get_installment(seeded_db, 999999)

    def test_list_filters_by_status_and_order(self, seeded_db):
        order_a = _order(seeded_db)
        order_b = _order(seeded_db)
        contract_a = _contract(seeded_db, order_a.id)
        contract_b = _contract(seeded_db, order_b.id)

        by_status = installment_service.list_installments(
            seeded_db, status=InstallmentStatus.PENDING.value
        )
        assert {c.id for c in by_status} == {contract_a.id, contract_b.id}

        by_order = installment_service.list_installments(seeded_db, order_id=order_b.id)
        assert [c.id for c in by_order] == [contract_b.id]
        assert contract_a.id not in [c.id for c in by_order]

    def test_installment_scope_follows_order_owner(self, seeded_db):
        scoped_user = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        own_order = _order(seeded_db, owner_id=9)
        other_order = _order(seeded_db, owner_id=8)
        own_contract = _contract(seeded_db, own_order.id)
        other_contract = _contract(seeded_db, other_order.id)

        visible = installment_service.list_installments(seeded_db, user=scoped_user)
        assert [item.id for item in visible] == [own_contract.id]
        with pytest.raises(NotFound):
            installment_service.get_installment(seeded_db, other_contract.id, scoped_user)


# ------------------------------------------------------------------ 收款守卫
class TestPayGuards:
    def _settled_dfq(self, seeded_db, tag: str) -> tuple[Order, Installment]:
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="500"
        )
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=1, actor="pytest",
        )
        return order, contract

    def test_pay_on_delivered_contract_conflicts(self, seeded_db):
        order, contract = self._settled_dfq(seeded_db, "paid-delivered")
        installment_service.deliver(
            seeded_db, contract.id, delivery_mode=DeliveryMode.PLATFORM_OPERATOR.value,
            delivered_on=TODAY, note="平台操作换绑凭证", actor="pytest",
        )
        with pytest.raises(Conflict) as exc:
            installment_service.pay(
                seeded_db, contract.id, amount=Decimal("1"), paid_on=TODAY,
                actor="pytest",
            )
        assert "不可收款" in str(exc.value)

    def test_pay_unknown_period_notfound(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id, periods=1)
        with pytest.raises(NotFound) as exc:
            installment_service.pay(
                seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
                period_no=99, actor="pytest",
            )
        assert "期次" in str(exc.value)

    def test_pay_without_period_auto_picks_first_unpaid(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=2, per_period="300"
        )
        # 未指定期次：按到期日顺序取第一笔未收满 → 期次 0（首付）
        _, first = installment_service.pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            actor="pytest",
        )
        assert first.period_no == 0
        # 期次 0 收满后自动落到期次 1
        _, second = installment_service.pay(
            seeded_db, contract.id, amount=Decimal("50"), paid_on=TODAY,
            actor="pytest",
        )
        assert second.period_no == 1
        assert second.status == ScheduleStatus.PARTIAL.value

    def test_pick_schedule_all_paid_is_defensive(self, seeded_db):
        # 收满后 remaining_total=0，pay() 在 _pick_schedule 之前即被"超收"拦下；
        # 直调私有函数覆盖"所有期次已收满"防御分支
        _, contract = self._settled_dfq(seeded_db, "allpaid")
        with pytest.raises(Validation) as exc:
            installment_service._pick_schedule(seeded_db, contract, None, TODAY)
        assert "所有期次已收满" in str(exc.value)


# ------------------------------------------------------------------ 交付守卫
class TestDeliverGuards:
    def _settled(self, seeded_db, tag: str) -> Installment:
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="500"
        )
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=1, actor="pytest",
        )
        return contract

    def test_deliver_invalid_mode_rejected(self, seeded_db):
        contract = self._settled(seeded_db, "bad-mode")
        with pytest.raises(Validation) as exc:
            installment_service.deliver(
                seeded_db, contract.id, delivery_mode="BOGUS",
                delivered_on=TODAY, note="凭证", actor="pytest",
            )
        assert "交付方式" in str(exc.value)

    def test_deliver_requires_note(self, seeded_db):
        contract = self._settled(seeded_db, "no-note")
        with pytest.raises(Validation) as exc:
            installment_service.deliver(
                seeded_db, contract.id,
                delivery_mode=DeliveryMode.CUSTOMER_SELF.value,
                delivered_on=TODAY, note="", actor="pytest",
            )
        assert "换绑凭证" in str(exc.value)


# ------------------------------------------------------------------ 逾期升级
class TestMarkOverdue:
    def test_overdue_promotes_active_contract(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="300",
            first_due_on=PAST,
        )
        # 收过首付 → 合约 ACTIVE（区别于 PENDING 分支）
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        marked = installment_service.mark_overdue(seeded_db, as_of=TODAY)
        assert marked == 1  # 期次 0 已收满不标记；期次 1 到期未收
        refreshed = seeded_db.get(Installment, contract.id)
        assert refreshed.status == InstallmentStatus.OVERDUE.value

        audit = seeded_db.scalar(
            select(AuditLog)
            .where(
                AuditLog.action == AuditAction.INSTALLMENT_OVERDUE.value,
                AuditLog.entity_id == contract.inst_no,
            )
            .order_by(AuditLog.id.desc())
        )
        assert audit is not None
        assert audit.after_json["overdue_periods"] == 1
        overdue = seeded_db.scalars(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == contract.id,
                InstallmentSchedule.status == ScheduleStatus.OVERDUE.value,
            )
        ).all()
        assert [row.period_no for row in overdue] == [1]

    def test_settle_early_collects_all_remaining_schedules(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="100",
            periods=2,
            per_period="300",
        )
        installment_service.pay(
            seeded_db,
            contract.id,
            amount=Decimal("100"),
            paid_on=TODAY,
            period_no=0,
            actor="pytest",
        )

        settled = installment_service.settle_early(
            seeded_db, contract.id, paid_on=TODAY, actor="pytest"
        )

        assert settled.status == InstallmentStatus.SETTLED.value
        assert settled.paid_amount == Decimal("700.00")
        schedules = seeded_db.scalars(
            select(InstallmentSchedule)
            .where(InstallmentSchedule.installment_id == contract.id)
            .order_by(InstallmentSchedule.period_no)
        ).all()
        assert [row.status for row in schedules] == [
            ScheduleStatus.PAID.value,
            ScheduleStatus.PAID.value,
            ScheduleStatus.PAID.value,
        ]

    def test_default_requires_overdue_and_keeps_unpaid_schedules(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="100",
            periods=1,
            per_period="300",
            first_due_on=PAST,
        )
        installment_service.pay(
            seeded_db,
            contract.id,
            amount=Decimal("100"),
            paid_on=TODAY,
            period_no=0,
            actor="pytest",
        )
        installment_service.mark_overdue(seeded_db, as_of=TODAY)

        defaulted = installment_service.mark_default(
            seeded_db, contract.id, actor="risk", reason="逾期未还"
        )

        assert defaulted.status == InstallmentStatus.DEFAULTED.value
        schedule = seeded_db.scalar(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == contract.id,
                InstallmentSchedule.period_no == 1,
            )
        )
        assert schedule.received_amount == Decimal("0.00")
        audit = seeded_db.scalar(
            select(AuditLog)
            .where(
                AuditLog.action == AuditAction.INSTALLMENT_DEFAULT.value,
                AuditLog.entity_id == contract.inst_no,
            )
            .order_by(AuditLog.id.desc())
        )
        assert audit is not None
        assert audit.reason == "逾期未还"

        with pytest.raises(Validation, match="逾期"):
            other_order = _order(seeded_db)
            other_contract = _contract(seeded_db, other_order.id)
            installment_service.mark_default(
                seeded_db, other_contract.id, actor="risk", reason="未逾期"
            )

    def test_waive_schedule_reduces_receivable_and_keeps_unpaid_history(
        self, seeded_db
    ):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="300"
        )

        schedule = installment_service.waive_schedule(
            seeded_db,
            contract.id,
            period_no=1,
            amount=Decimal("300"),
            waived_on=TODAY,
            actor="risk",
            reason="经审批减免",
        )

        seeded_db.refresh(contract)
        assert schedule.status == ScheduleStatus.WAIVED.value
        assert schedule.due_amount == Decimal("300.00")
        assert schedule.waived_amount == Decimal("300.00")
        assert contract.waived_amount == Decimal("300.00")
        assert installment_service.total_receivable(contract) == Decimal("100.00")
        with pytest.raises(Validation, match="超过剩余应收"):
            installment_service.pay(
                seeded_db, contract.id, amount=Decimal("301"), paid_on=TODAY,
                period_no=1, actor="pytest",
            )

    def test_waive_received_schedule_is_rejected(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id, periods=1, per_period="300")
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        with pytest.raises(Validation, match="已收期"):
            installment_service.waive_schedule(
                seeded_db,
                contract.id,
                period_no=0,
                amount=Decimal("1"),
                waived_on=TODAY,
                actor="risk",
                reason="不应修改",
            )

    def test_extend_schedule_changes_future_date_and_audits_original(
        self, seeded_db
    ):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, periods=1, per_period="300", first_due_on=TODAY
        )
        schedule = seeded_db.scalar(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == contract.id,
                InstallmentSchedule.period_no == 1,
            )
        )
        assert schedule is not None
        original_due_on = schedule.due_on

        extended = installment_service.extend_schedule(
            seeded_db,
            contract.id,
            period_no=1,
            new_due_on=date(2026, 12, 31),
            actor="risk",
            reason="客户申请展期",
        )

        assert extended.due_on == date(2026, 12, 31)
        audit = seeded_db.scalar(
            select(AuditLog)
            .where(
                AuditLog.action == AuditAction.INSTALLMENT_EXTEND.value,
                AuditLog.entity_id == contract.inst_no,
            )
            .order_by(AuditLog.id.desc())
        )
        assert audit is not None
        assert audit.before_json["due_on"] == original_due_on.isoformat()
        assert audit.after_json["due_on"] == "2026-12-31"


# ------------------------------------------------------------------ 路由层
class TestInstallmentsApi:
    def test_scoped_user_cannot_read_or_pay_other_order_contract(
        self, seeded_client, seeded_db
    ):
        own_order = _order(seeded_db, owner_id=9)
        other_order = _order(seeded_db, owner_id=8)
        own_contract = _contract(seeded_db, own_order.id)
        other_contract = _contract(seeded_db, other_order.id)
        user = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        scoped_headers = {"Authorization": f"Bearer {build_access_token(user)}"}

        listing = seeded_client.get("/api/v1/installments", headers=scoped_headers)
        assert listing.status_code == 200
        assert [row["id"] for row in listing.json()] == [own_contract.id]

        schedules = seeded_client.get(
            f"/api/v1/installments/{other_contract.id}/schedules",
            headers=scoped_headers,
        )
        assert schedules.status_code == 404

        payment = seeded_client.post(
            f"/api/v1/installments/{other_contract.id}/payments",
            json={"amount": "1.00", "paid_on": TODAY.isoformat()},
            headers=scoped_headers,
        )
        assert payment.status_code == 404

    def test_list_endpoint(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id)
        response = seeded_client.get(
            "/api/v1/installments", params={"status": "PENDING"}, headers=headers
        )
        assert response.status_code == 200, response.text
        assert [item["inst_no"] for item in response.json()] == [contract.inst_no]

    def test_deliver_endpoint(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="500"
        )
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        installment_service.pay(
            seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
            period_no=1, actor="pytest",
        )
        response = seeded_client.post(
            f"/api/v1/installments/{contract.id}/deliver",
            json={
                "delivery_mode": "PLATFORM_OPERATOR",
                "delivered_on": TODAY.isoformat(),
                "note": "平台操作换绑凭证",
            },
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["status"] == InstallmentStatus.DELIVERED.value

    def test_settle_early_and_default_endpoints(
        self, seeded_client, seeded_db, headers
    ):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="100",
            periods=1,
            per_period="300",
        )
        paid = seeded_client.post(
            f"/api/v1/installments/{contract.id}/payments",
            json={
                "amount": "100",
                "paid_on": TODAY.isoformat(),
                "period_no": 0,
            },
            headers=headers,
        )
        assert paid.status_code == 200, paid.text

        early = seeded_client.post(
            f"/api/v1/installments/{contract.id}/settle-early",
            json={"paid_on": TODAY.isoformat(), "note": "一次性结清"},
            headers=headers,
        )
        assert early.status_code == 200, early.text
        assert early.json()["status"] == InstallmentStatus.SETTLED.value

        overdue_order = _order(seeded_db)
        overdue_contract = _contract(
            seeded_db,
            overdue_order.id,
            down_payment="100",
            periods=1,
            per_period="300",
            first_due_on=PAST,
        )
        overdue_paid = seeded_client.post(
            f"/api/v1/installments/{overdue_contract.id}/payments",
            json={
                "amount": "100",
                "paid_on": TODAY.isoformat(),
                "period_no": 0,
            },
            headers=headers,
        )
        assert overdue_paid.status_code == 200, overdue_paid.text
        marked = seeded_client.post(
            "/api/v1/installments/mark-overdue",
            params={"as_of": TODAY.isoformat()},
            headers=headers,
        )
        assert marked.status_code == 200, marked.text
        defaulted = seeded_client.post(
            f"/api/v1/installments/{overdue_contract.id}/default",
            json={"reason": "超过约定期限"},
            headers=headers,
        )
        assert defaulted.status_code == 200, defaulted.text
        assert defaulted.json()["status"] == InstallmentStatus.DEFAULTED.value

    def test_mark_overdue_endpoint(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        _contract(
            seeded_db, order.id, down_payment="0", periods=2, per_period="300",
            first_due_on=PAST,
        )
        response = seeded_client.post(
            "/api/v1/installments/mark-overdue",
            params={"as_of": TODAY.isoformat()},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert response.json()["marked"] == 2

    def test_waive_and_extend_schedule_endpoints(
        self, seeded_client, seeded_db, headers
    ):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, periods=1, per_period="300", first_due_on=TODAY
        )
        extended = seeded_client.post(
            f"/api/v1/installments/{contract.id}/schedules/1/extend",
            json={"new_due_on": "2026-12-31", "reason": "客户申请展期"},
            headers=headers,
        )
        assert extended.status_code == 200, extended.text
        assert extended.json()["due_on"] == "2026-12-31"

        waived = seeded_client.post(
            f"/api/v1/installments/{contract.id}/schedules/1/waive",
            json={
                "amount": "300",
                "waived_on": TODAY.isoformat(),
                "reason": "审批减免",
            },
            headers=headers,
        )
        assert waived.status_code == 200, waived.text
        assert waived.json()["status"] == ScheduleStatus.WAIVED.value
        assert waived.json()["waived_amount"] == "300.00"

    def test_scoped_user_mark_overdue_only_updates_visible_orders(
        self, seeded_client, seeded_db
    ):
        own_order = _order(seeded_db, owner_id=9)
        foreign_order = _order(seeded_db, owner_id=8)
        own_contract = _contract(
            seeded_db, own_order.id, down_payment="0", periods=1, per_period="300",
            first_due_on=PAST,
        )
        foreign_contract = _contract(
            seeded_db, foreign_order.id, down_payment="0", periods=1, per_period="300",
            first_due_on=PAST,
        )
        user = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        scoped_headers = {"Authorization": f"Bearer {build_access_token(user)}"}

        response = seeded_client.post(
            "/api/v1/installments/mark-overdue",
            params={"as_of": TODAY.isoformat()},
            headers=scoped_headers,
        )

        assert response.status_code == 200, response.text
        assert response.json()["marked"] == 1
        own_schedule = seeded_db.scalar(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == own_contract.id,
                InstallmentSchedule.period_no == 1,
            )
        )
        foreign_schedule = seeded_db.scalar(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == foreign_contract.id,
                InstallmentSchedule.period_no == 1,
            )
        )
        assert own_schedule.status == ScheduleStatus.OVERDUE.value
        assert foreign_schedule.status == ScheduleStatus.PENDING.value
