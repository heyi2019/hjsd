"""installments.repayments.waive：期次减免（BAS-03，从 repayment.py 逐字拆出）。"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any
from app.shared.audit import record_audit
from app.core.security import CurrentUser
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import NotFound, Validation, ErrorCode
from app.core.money import to_money
from app.shared.operation_operators import upsert_operation_operators
from app.core.state_machine import INSTALLMENT_TRANSITIONS, transition
from app.domain.enums import AuditAction, InstallmentStatus, ScheduleStatus
from app.domain.trade import InstallmentSchedule
from .._shared import SCHEDULE_CLOSED_STATUSES, _merge_form_extra, _positive, _required_text, get_installment
from app.shared.installment_amounts import total_receivable

def waive_schedule(
    session: Session,
    installment_id: int,
    *,
    period_no: int,
    amount: Any,
    waived_on: date,
    actor: str,
    reason: str,
    form_extra: Mapping[str, Any] | None = None,
    operator_user_ids: list[int] | None = None,
    user: CurrentUser | None = None,
) -> InstallmentSchedule:
    """登记经授权的期次减免，不改写原应收金额。"""
    text_reason = _required_text(reason, field="reason", message="减免必须填写原因")
    installment = get_installment(session, installment_id, user, for_update=True)
    if installment.status in SCHEDULE_CLOSED_STATUSES:
        raise Validation("已结束的分期合约不能减免")
    _merge_form_extra(
        session, installment, scope="INSTWAIVE", values=form_extra,
        context={"amount": amount, "waived_on": waived_on, "reason": reason,
                 "period_no": period_no, "operator_user_ids": operator_user_ids},
    )
    schedule = session.scalar(
        select(InstallmentSchedule).where(
            InstallmentSchedule.installment_id == installment.id,
            InstallmentSchedule.period_no == period_no,
        ).execution_options(populate_existing=True)
    )
    if schedule is None:
        raise NotFound(f"期次 {period_no} 不存在", details={"period_no": period_no})
    if to_money(schedule.received_amount) > 0:
        raise Validation("已收期不可减免", details={"period_no": period_no})
    if schedule.status in {ScheduleStatus.PAID.value, ScheduleStatus.WAIVED.value}:
        raise Validation("已完成期次不可减免", details={"period_no": period_no})
    money = _positive(amount, field="amount")
    outstanding = to_money(schedule.due_amount) - to_money(schedule.waived_amount)
    if money > outstanding:
        raise Validation(
            "减免金额超过未收金额",
            code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE,
            details={"period_no": period_no, "outstanding": str(outstanding)},
        )
    before_waived = to_money(schedule.waived_amount)
    schedule.waived_amount = before_waived + money
    if to_money(schedule.received_amount) + to_money(schedule.waived_amount) >= to_money(
        schedule.due_amount
    ):
        schedule.status = ScheduleStatus.WAIVED.value
    installment.waived_amount = to_money(installment.waived_amount) + money
    if (
        installment.status
        in {
            InstallmentStatus.PENDING.value,
            InstallmentStatus.ACTIVE.value,
            InstallmentStatus.OVERDUE.value,
        }
        and to_money(installment.paid_amount) >= total_receivable(installment)
    ):
        installment.status = transition(
            INSTALLMENT_TRANSITIONS,
            installment.status,
            "SETTLE",
            entity="分期合约",
        )
    installment.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.INSTALLMENT_WAIVE,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        before={
            "period_no": period_no,
            "due_amount": str(schedule.due_amount),
            "waived_amount": str(before_waived),
        },
        after={
            "period_no": period_no,
            "due_amount": str(schedule.due_amount),
            "waived_amount": str(schedule.waived_amount),
            "status": schedule.status,
            "waived_on": waived_on.isoformat(),
        },
        reason=text_reason,
    )
    upsert_operation_operators(
        session,
        entity_type="installment",
        entity_id=installment.inst_no,
        operation_key=f"WAIVE:{period_no}",
        actor=actor,
        operator_user_ids=operator_user_ids,
    )
    return schedule
