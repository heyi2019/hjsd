"""installments.repayments.pay：收款与期次选取（BAS-03，从 repayment.py 逐字拆出）。"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any
from app.shared.audit import record_audit
from app.core.security import CurrentUser
from app.domain.enums import CashflowSourceType, Direction
from app.domain.cashflow_attributes import accounting_attribute_for_order_event
from app.funds.cashflows import create_cashflow
from app.business.events_rules import _resolve_pool
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.shared.operation_operators import upsert_operation_operators
from app.core.state_machine import INSTALLMENT_TRANSITIONS, transition
from app.domain.enums import AuditAction, EventType, InstallmentStatus, ScheduleStatus
from app.domain.trade import Installment, InstallmentSchedule, Order
from .._shared import _merge_form_extra, _positive, get_installment
from app.shared.installment_amounts import total_receivable

def pay(
    session: Session,
    installment_id: int,
    *,
    amount: Any,
    paid_on: date,
    period_no: int | None = None,
    actor: str,
    pool_id: int | None = None,
    note: str | None = None,
    form_extra: Mapping[str, Any] | None = None,
    operator_user_ids: list[int] | None = None,
    validate_form_fields: bool = True,
    user: CurrentUser | None = None,
) -> tuple[Installment, InstallmentSchedule]:
    """收款：直接登记收入资金明细，不创建订单业务事件。"""
    installment = get_installment(session, installment_id, user, for_update=True)
    order = session.get(Order, installment.order_id)
    if order is None:
        raise NotFound("分期合约所属订单不存在", details={"order_id": installment.order_id})
    # 售出首付和提前结清内部生成的收款不对应单独的收款表单。
    if validate_form_fields:
        _merge_form_extra(session, installment, scope="INSTPAY", values=form_extra)
    if installment.status in (
        InstallmentStatus.CANCELLED.value,
        InstallmentStatus.DELIVERED.value,
        InstallmentStatus.CLOSED.value,
    ):
        raise Conflict(
            f"合约 {installment.inst_no} 状态 {installment.status}，不可收款",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"inst_no": installment.inst_no, "status": installment.status},
        )

    money = _positive(amount, field="amount")
    remaining_total = total_receivable(installment) - to_money(installment.paid_amount)
    if money > remaining_total:
        raise Validation(
            "收款金额超过剩余应收",
            code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE,
            details={
                "inst_no": installment.inst_no,
                "remaining": str(remaining_total),
                "amount": str(money),
            },
        )

    schedule = _pick_schedule(session, installment, period_no, paid_on)
    outstanding = (
        to_money(schedule.due_amount)
        - to_money(schedule.received_amount)
        - to_money(schedule.waived_amount)
    )
    if money > outstanding:
        raise Validation(
            f"第 {schedule.period_no} 期剩余应收 {outstanding}",
            code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE,
            details={"period_no": schedule.period_no, "outstanding": str(outstanding)},
        )

    accounting_attribute = accounting_attribute_for_order_event(
        order.order_type, EventType.SELL.value
    )
    resolved_pool_id = pool_id
    if resolved_pool_id is None:
        resolved_pool_id = _resolve_pool(session, order, "PROFIT").id
    create_cashflow(
        session,
        pool_id=resolved_pool_id,
        occurred_on=paid_on,
        direction=Direction.IN.value,
        accounting_attribute=accounting_attribute,
        category="INSTALLMENT_PAYMENT",
        amount=money,
        source_type=CashflowSourceType.INSTALLMENT.value,
        source_id=installment.inst_no,
        actor=actor,
        operator_user_ids=operator_user_ids,
        order_id=order.id,
        note=note or f"分期收款 {installment.inst_no} 第 {schedule.period_no} 期",
        form_extra_scope=None,
        user=user,
    )
    schedule.received_amount = to_money(schedule.received_amount) + money
    schedule.received_on = paid_on
    schedule.status = (
        ScheduleStatus.PAID.value
        if schedule.received_amount + schedule.waived_amount >= schedule.due_amount
        else ScheduleStatus.PARTIAL.value
    )
    installment.paid_amount = to_money(installment.paid_amount) + money
    installment.updated_by = actor

    if installment.status == InstallmentStatus.PENDING.value:
        installment.status = transition(
            INSTALLMENT_TRANSITIONS,
            installment.status,
            "INSTALLMENT_PAYMENT",
            entity="分期合约",
        )
    if to_money(installment.paid_amount) >= total_receivable(installment):
        if installment.status != InstallmentStatus.DEFAULTED.value:
            installment.status = transition(
                INSTALLMENT_TRANSITIONS,
                installment.status,
                "SETTLE",
                entity="分期合约",
            )
    session.flush()

    record_audit(
        session,
        action=AuditAction.INSTALLMENT_EARLY_SETTLE,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        after={
            "period_no": schedule.period_no,
            "amount": str(money),
            "paid_total": str(to_money(installment.paid_amount)),
            "status": installment.status,
        },
    )
    upsert_operation_operators(
        session,
        entity_type="installment",
        entity_id=installment.inst_no,
        operation_key=f"PAY:{schedule.id}",
        actor=actor,
        operator_user_ids=operator_user_ids,
        occurred_at=None,
    )
    return installment, schedule


def _pick_schedule(
    session: Session, installment: Installment, period_no: int | None, paid_on: date
) -> InstallmentSchedule:
    if period_no is not None:
        schedule = session.scalar(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == installment.id,
                InstallmentSchedule.period_no == period_no,
            ).execution_options(populate_existing=True)
        )
        if schedule is None:
            raise NotFound(
                f"期次 {period_no} 不存在", details={"period_no": period_no}
            )
        return schedule
    # 未指定期次：按到期日顺序取第一笔未收满的期次
    schedule = session.scalars(
        select(InstallmentSchedule)
        .where(
            InstallmentSchedule.installment_id == installment.id,
            InstallmentSchedule.received_amount + InstallmentSchedule.waived_amount
            < InstallmentSchedule.due_amount,
        )
        .order_by(InstallmentSchedule.period_no)
        .execution_options(populate_existing=True)
    ).first()
    if schedule is None:
        raise Validation(
            "所有期次已收满", code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE
        )
    return schedule
