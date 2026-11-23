"""分期期次展期。"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any
from app.shared.audit import record_audit
from app.core.security import CurrentUser
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import NotFound, Validation
from app.core.money import to_money
from app.shared.operation_operators import upsert_operation_operators
from app.domain.enums import AuditAction, ScheduleStatus
from app.domain.trade import InstallmentSchedule
from .._shared import SCHEDULE_CLOSED_STATUSES, _merge_form_extra, _required_text, _restore_when_overdue_cleared, get_installment

def extend_schedule(
    session: Session,
    installment_id: int,
    *,
    period_no: int,
    new_due_on: date,
    actor: str,
    reason: str,
    form_extra: Mapping[str, Any] | None = None,
    operator_user_ids: list[int] | None = None,
    user: CurrentUser | None = None,
) -> InstallmentSchedule:
    """修改未收期次到期日，并通过审计保留原计划日期。"""
    text_reason = _required_text(reason, field="reason", message="展期必须填写原因")
    installment = get_installment(session, installment_id, user, for_update=True)
    if installment.status in SCHEDULE_CLOSED_STATUSES:
        raise Validation("已结束的分期合约不能展期")
    _merge_form_extra(
        session, installment, scope="INSTEXTEND", values=form_extra,
        context={"new_due_on": new_due_on, "reason": reason, "period_no": period_no,
                 "operator_user_ids": operator_user_ids},
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
        raise Validation("已收期不可展期", details={"period_no": period_no})
    if schedule.status in {ScheduleStatus.PAID.value, ScheduleStatus.WAIVED.value}:
        raise Validation("已完成期次不可展期", details={"period_no": period_no})
    if to_money(schedule.received_amount) + to_money(schedule.waived_amount) >= to_money(schedule.due_amount):
        raise Validation("该期没有剩余应收，不可展期", details={"period_no": period_no})
    if new_due_on <= schedule.due_on:
        raise Validation("展期后的到期日必须晚于原到期日", details={"field": "new_due_on"})
    original_due_on = schedule.due_on
    schedule.due_on = new_due_on
    if schedule.status == ScheduleStatus.OVERDUE.value and new_due_on >= date.today():
        schedule.status = ScheduleStatus.PENDING.value
    installment.updated_by = actor
    session.flush()
    _restore_when_overdue_cleared(session, installment)
    record_audit(
        session,
        action=AuditAction.INSTALLMENT_EXTEND,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        before={"period_no": period_no, "due_on": original_due_on.isoformat()},
        after={"period_no": period_no, "due_on": new_due_on.isoformat()},
        reason=text_reason,
    )
    upsert_operation_operators(
        session,
        entity_type="installment",
        entity_id=installment.inst_no,
        operation_key=f"EXTEND:{period_no}",
        actor=actor,
        operator_user_ids=operator_user_ids,
    )
    return schedule
