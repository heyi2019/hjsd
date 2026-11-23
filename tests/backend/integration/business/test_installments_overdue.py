"""API-01 分期逾期升级契约：TestMarkOverdue 拆出（11 tests）。"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
import pytest
from sqlalchemy import select

from app.core.errors import Validation
from app.domain.enums import (
    AuditAction,
    InstallmentContractType,
    InstallmentStatus,
    ScheduleStatus)
from app.domain.foundation import AuditLog
from app.domain.trade import Installment, InstallmentSchedule
from app.shared.installment_amounts import total_receivable
from app.business.installments import create as inst_create
from app.business.installments import recovery as inst_recovery
from app.business.installments.repayments.pay import pay as inst_pay
from app.business.installments.repayments.waive import waive_schedule as inst_waive
from app.business.installments.repayments.extend import extend_schedule as inst_extend
from app.business.installments import settlement as inst_settlement
from app.business.orders.create import create_order
from app.business.orders.events import post_event

TODAY = date(2026, 10, 12)
PAST = date(2026, 9, 1)

def _account(seeded_db, game_account: str):
    from app.business.inventory.profile import create_account

    return create_account(
        seeded_db,
        game_account=game_account,
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )

def _order(seeded_db, *, order_type="TH", account_id=None, owner_id=None, trade_date=TODAY):
    return create_order(
        seeded_db, order_type=order_type, trade_date=trade_date, actor="pytest",
        account_id=account_id, owner_id=owner_id,
    )

def _buy(seeded_db, order_id: int, amount="800"):
    post_event(
        seeded_db, order_id, event_type="BUY", amount=Decimal(amount),
        occurred_on=TODAY, actor="pytest",
    )

def _contract(
    seeded_db,
    order_id: int,
    *,
    contract_type=InstallmentContractType.PICKUP_SALE.value,
    principal=None,
    down_payment="100",
    periods=2,
    per_period="300",
    first_due_on=TODAY,
    **kwargs,
) -> Installment:
    if principal is None:
        principal = str(Decimal(down_payment) + Decimal(per_period) * periods)
    return inst_create.create_installment(
        seeded_db,
        order_id=order_id,
        contract_type=contract_type,
        principal=Decimal(principal),
        down_payment=Decimal(down_payment),
        periods=periods,
        per_period=Decimal(per_period),
        first_due_on=first_due_on,
        actor="pytest",
        **kwargs,
    )


class TestMarkOverdue:
    def test_partial_payment_keeps_overdue_then_clearing_last_overdue_restores_active(self, seeded_db):
        today = date.today()
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="0", periods=2, per_period="300",
            first_due_on=today - timedelta(days=5),
        )
        inst_recovery.mark_overdue(seeded_db, as_of=today)
        assert contract.status == InstallmentStatus.OVERDUE.value
        _, schedule = inst_pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=today, period_no=1, actor="pytest",
        )
        assert schedule.status == ScheduleStatus.OVERDUE.value
        assert contract.status == InstallmentStatus.OVERDUE.value
        _, schedule = inst_pay(
            seeded_db, contract.id, amount=Decimal("200"), paid_on=today, period_no=1, actor="pytest",
        )
        assert schedule.status == ScheduleStatus.PAID.value
        assert contract.status == InstallmentStatus.ACTIVE.value

    def test_extension_restores_pending_only_after_all_overdue_periods_are_cleared(self, seeded_db):
        today = date.today()
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="0", periods=2, per_period="300",
            first_due_on=today - timedelta(days=45),
        )
        inst_recovery.mark_overdue(seeded_db, as_of=today)
        first = inst_extend(
            seeded_db, contract.id, period_no=1, new_due_on=today - timedelta(days=10),
            actor="pytest", reason="部分展期",
        )
        assert first.status == ScheduleStatus.OVERDUE.value
        assert contract.status == InstallmentStatus.OVERDUE.value
        inst_extend(
            seeded_db, contract.id, period_no=1, new_due_on=today + timedelta(days=7),
            actor="pytest", reason="继续展期",
        )
        assert contract.status == InstallmentStatus.OVERDUE.value
        inst_extend(
            seeded_db, contract.id, period_no=2, new_due_on=today + timedelta(days=14),
            actor="pytest", reason="二期展期",
        )
        assert contract.status == InstallmentStatus.PENDING.value

    def test_waiving_last_overdue_period_restores_unpaid_contract(self, seeded_db):
        today = date.today()
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="0", periods=2, per_period="300",
            first_due_on=today - timedelta(days=5),
        )
        inst_recovery.mark_overdue(seeded_db, as_of=today)
        schedule = inst_waive(
            seeded_db, contract.id, period_no=1, amount=Decimal("300"), waived_on=today,
            actor="pytest", reason="审批减免",
        )
        assert schedule.status == ScheduleStatus.WAIVED.value
        assert contract.status == InstallmentStatus.PENDING.value

    def test_overdue_updates_contract_operator(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="0",
            periods=1,
            per_period="300",
            first_due_on=PAST,
        )

        inst_recovery.mark_overdue(seeded_db, as_of=TODAY, actor="risk")

        assert contract.updated_by == "risk"

    def test_terminal_contract_is_not_marked_overdue(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="0",
            periods=1,
            per_period="300",
            first_due_on=PAST,
        )
        contract.status = InstallmentStatus.CANCELLED.value
        seeded_db.flush()

        marked = inst_recovery.mark_overdue(seeded_db, as_of=TODAY)

        assert marked == 0
        schedules = seeded_db.scalars(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == contract.id
            )
        ).all()
        assert all(row.status != ScheduleStatus.OVERDUE.value for row in schedules)

    def test_overdue_promotes_pending_contract(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="0",
            periods=1,
            per_period="300",
            first_due_on=PAST,
        )

        marked = inst_recovery.mark_overdue(seeded_db, as_of=TODAY)

        assert marked == 1  # 零首付期无需逾期，第 1 期进入逾期
        refreshed = seeded_db.get(Installment, contract.id)
        assert refreshed.status == InstallmentStatus.OVERDUE.value

    def test_overdue_promotes_active_contract(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="300",
            first_due_on=PAST,
        )
        # 收过首付 → 合约 ACTIVE（区别于 PENDING 分支）
        inst_pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        marked = inst_recovery.mark_overdue(seeded_db, as_of=TODAY)
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
        inst_pay(
            seeded_db,
            contract.id,
            amount=Decimal("100"),
            paid_on=TODAY,
            period_no=0,
            actor="pytest",
        )

        settled = inst_settlement.settle_early(
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
        inst_pay(
            seeded_db,
            contract.id,
            amount=Decimal("100"),
            paid_on=TODAY,
            period_no=0,
            actor="pytest",
        )
        inst_recovery.mark_overdue(seeded_db, as_of=TODAY)

        defaulted = inst_settlement.mark_default(
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
            inst_settlement.mark_default(
                seeded_db, other_contract.id, actor="risk", reason="未逾期"
            )

    def test_payment_after_default_does_not_rewrite_default_status(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db,
            order.id,
            down_payment="0",
            periods=1,
            per_period="300",
            first_due_on=PAST,
        )
        inst_recovery.mark_overdue(seeded_db, as_of=TODAY)
        inst_settlement.mark_default(
            seeded_db, contract.id, actor="risk", reason="逾期未还"
        )

        paid, _schedule = inst_pay(
            seeded_db,
            contract.id,
            amount=Decimal("300"),
            paid_on=TODAY,
            period_no=1,
            actor="collector",
        )

        assert paid.paid_amount == Decimal("300.00")
        assert paid.status == InstallmentStatus.DEFAULTED.value

    def test_installment_action_reasons_require_text_values(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id, first_due_on=PAST)
        inst_recovery.mark_overdue(seeded_db, as_of=TODAY)
        with pytest.raises(Validation, match="违约处置必须填写原因"):
            inst_settlement.mark_default(
                seeded_db, contract.id, actor="risk", reason=123
            )

    def test_waive_schedule_reduces_receivable_and_keeps_unpaid_history(
        self, seeded_db
    ):
        order = _order(seeded_db)
        contract = _contract(
            seeded_db, order.id, down_payment="100", periods=1, per_period="300"
        )

        schedule = inst_waive(
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
        assert total_receivable(contract) == Decimal("100.00")
        with pytest.raises(Validation, match="超过剩余应收"):
            inst_pay(
                seeded_db, contract.id, amount=Decimal("301"), paid_on=TODAY,
                period_no=1, actor="pytest",
            )

    def test_waive_received_schedule_is_rejected(self, seeded_db):
        order = _order(seeded_db)
        contract = _contract(seeded_db, order.id, periods=1, per_period="300")
        inst_pay(
            seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
            period_no=0, actor="pytest",
        )
        with pytest.raises(Validation, match="已收期"):
            inst_waive(
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

        extended = inst_extend(
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


