"""installments.settlement：提前结清与违约标记（BAS-03）。
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any
from app.core.audit import record_audit
from app.core.security import CurrentUser
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import (
    Conflict,
    ErrorCode,
    Validation,
)
from app.core.money import to_money
from app.core.operation_operators import upsert_operation_operators
from app.core.state_machine import (
    INSTALLMENT_TRANSITIONS,
    transition,
)
from app.domain.enums import (
    AuditAction,
    InstallmentStatus,
)
from app.domain.trade import (
    Installment,
    InstallmentSchedule,
)

from .repayment import pay

from ._shared import (
    _merge_form_extra,
    _required_text,
    get_installment,
)

def settle_early(
    session: Session,
    installment_id: int,
    *,
    paid_on: date,
    actor: str,
    pool_id: int | None = None,
    note: str | None = None,
    form_extra: Mapping[str, Any] | None = None,
    operator_user_ids: list[int] | None = None,
    user: CurrentUser | None = None,
) -> Installment:
    """提前收清剩余应收，逐期生成分期收入资金明细并关闭未来计划。"""
    installment = get_installment(session, installment_id, user)
    _merge_form_extra(session, installment, scope="INSTSETTLE", values=form_extra)
    if installment.status in (
        InstallmentStatus.CANCELLED.value,
        InstallmentStatus.DELIVERED.value,
        InstallmentStatus.SETTLED.value,
    ):
        raise Conflict(
            f"合约 {installment.inst_no} 状态 {installment.status}，不可提前结清",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"inst_no": installment.inst_no, "status": installment.status},
        )
    rows = session.scalars(
        select(InstallmentSchedule)
        .where(
            InstallmentSchedule.installment_id == installment.id,
            InstallmentSchedule.received_amount + InstallmentSchedule.waived_amount
            < InstallmentSchedule.due_amount,
        )
        .order_by(InstallmentSchedule.period_no)
    ).all()
    if not rows:
        raise Validation("合约没有剩余应收，不能重复提前结清")
    for row in rows:
        outstanding = (
            to_money(row.due_amount)
            - to_money(row.received_amount)
            - to_money(row.waived_amount)
        )
        # 按当前实现走不到这里：上面的查询已用 `received + waived < due` 过滤，
        # 三列都是 DECIMAL(18,2)，库上还有 ck_installment_schedules_settled_amount_within_due，
        # 故 outstanding 恒 ≥ 0.01。保留它是为了防「循环内的陈旧读」——若 payable 的
        # pay() 将来支持跨期顺延，前一期收款会把后一期补满，rows 里的 ORM 对象随之
        # 变更，该期就不该再收；删掉换来的不是安全，而是那种场景下 pay(amount<=0)
        # 抛 Validation、提前结清直接失败。要删请连这段注释一起删，别只删 if。
        if outstanding <= 0:  # pragma: no cover - 见上，不可达分支
            continue
        pay(
            session,
            installment.id,
            amount=outstanding,
            paid_on=paid_on,
            period_no=row.period_no,
            actor=actor,
            pool_id=pool_id,
            note=note or f"提前结清 {installment.inst_no} 第 {row.period_no} 期",
            operator_user_ids=operator_user_ids,
            user=user,
        )
    session.flush()
    record_audit(
        session,
        action=AuditAction.INSTALLMENT_PAYMENT,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        after={
            "action": "SETTLE_EARLY",
            "paid_total": str(to_money(installment.paid_amount)),
            "status": installment.status,
        },
    )
    upsert_operation_operators(
        session,
        entity_type="installment",
        entity_id=installment.inst_no,
        operation_key="SETTLE",
        actor=actor,
        operator_user_ids=operator_user_ids,
    )
    return installment


def mark_default(
    session: Session,
    installment_id: int,
    *,
    actor: str,
    reason: str,
    form_extra: Mapping[str, Any] | None = None,
    operator_user_ids: list[int] | None = None,
    user: CurrentUser | None = None,
) -> Installment:
    """将逾期合约置为违约，保留未收计划供后续追偿。"""
    text_reason = _required_text(
        reason, field="reason", message="违约处置必须填写原因"
    )
    installment = get_installment(session, installment_id, user)
    _merge_form_extra(session, installment, scope="INSTDEFAULT", values=form_extra)
    if installment.status != InstallmentStatus.OVERDUE.value:
        raise Validation(
            f"合约 {installment.inst_no} 当前不是逾期状态，不能登记违约",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"inst_no": installment.inst_no, "status": installment.status},
        )
    installment.status = transition(
        INSTALLMENT_TRANSITIONS,
        installment.status,
        "DEFAULT",
        entity="分期合约",
    )
    installment.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.INSTALLMENT_DEFAULT,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        after={"status": installment.status},
        reason=text_reason,
    )
    upsert_operation_operators(
        session,
        entity_type="installment",
        entity_id=installment.inst_no,
        operation_key="DEFAULT",
        actor=actor,
        operator_user_ids=operator_user_ids,
    )
    return installment
