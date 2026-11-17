"""installments.repayment：还款、取消、减免、展期与期次选取（BAS-03）。
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from decimal import Decimal
from typing import Any
from app.core.audit import record_audit
from app.core.security import CurrentUser
from app.domain.enums import CashflowSourceType, Direction, FundNature, Nature
from app.finance.attributes import accounting_attribute_for_order_event
from app.finance.cashflows import create_cashflow, reverse_cashflow
from app.orders.events_rules import _resolve_pool
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import (
    Conflict,
    ErrorCode,
    NotFound,
    Validation,
)
from app.core.money import to_money
from app.core.operation_operators import upsert_operation_operators
from app.core.state_machine import (
    INSTALLMENT_TRANSITIONS,
    ORDER_TRANSITIONS,
    transition,
)
from app.orders.cancellation_model import apply_installment_cancellation_account_effect
from app.domain.enums import AuditAction, EventType, InstallmentStatus, ScheduleStatus
from app.domain.trade import (
    Installment,
    InstallmentSchedule,
    Order,
    Cashflow,
)

from ._shared import (
    _merge_form_extra,
    _positive,
    _required_text,
    get_installment,
    total_receivable,
)

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
    user: CurrentUser | None = None,
) -> tuple[Installment, InstallmentSchedule]:
    """收款：直接登记收入资金明细，不创建订单业务事件。"""
    installment = get_installment(session, installment_id, user)
    order = session.get(Order, installment.order_id)
    if order is None:
        raise NotFound("分期合约所属订单不存在", details={"order_id": installment.order_id})
    _merge_form_extra(session, installment, scope="INSTPAY", values=form_extra)
    if installment.status in (
        InstallmentStatus.CANCELLED.value,
        InstallmentStatus.DELIVERED.value,
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
    fund_nature = FundNature.BUSINESS.value
    resolved_pool_id = pool_id
    if resolved_pool_id is None:
        resolved_pool_id = _resolve_pool(
            session, order, "PROFIT", fund_nature=fund_nature
        ).id
    create_cashflow(
        session,
        pool_id=resolved_pool_id,
        occurred_on=paid_on,
        direction=Direction.IN.value,
        nature=Nature.BUSINESS_IN.value,
        accounting_attribute=accounting_attribute,
        category="INSTALLMENT_PAYMENT",
        amount=money,
        source_type=CashflowSourceType.INSTALLMENT.value,
        source_id=installment.inst_no,
        actor=actor,
        operator_user_ids=operator_user_ids,
        order_id=order.id,
        note=note or f"分期收款 {installment.inst_no} 第 {schedule.period_no} 期",
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


def cancel_installment(
    session: Session,
    installment_id: int,
    *,
    cancelled_on: date,
    actor: str,
    reason: str,
    form_extra: Mapping[str, Any] | None = None,
    operator_user_ids: list[int] | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """终止交付前分期并冲销已登记的收款资金明细。"""
    text_reason = _required_text(reason, field="reason", message="取消分期必须填写原因")
    installment = get_installment(session, installment_id, user)
    cancellable = {
        InstallmentStatus.PENDING.value,
        InstallmentStatus.ACTIVE.value,
        InstallmentStatus.OVERDUE.value,
    }
    if installment.status not in cancellable:
        raise Conflict(
            f"合约 {installment.inst_no} 状态 {installment.status}，不能取消",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"inst_no": installment.inst_no, "status": installment.status},
        )

    order = session.get(Order, installment.order_id)
    if order is None:
        raise NotFound("分期合约所属订单不存在", details={"order_id": installment.order_id})
    if order.status not in {"ACTIVE", "INSTALLMENT"}:
        raise Conflict(
            f"订单 {order.order_no} 当前状态 {order.status}，不能取消分期",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"order_no": order.order_no, "status": order.status},
        )
    if form_extra:
        _merge_form_extra(session, installment, scope="INSTCANCEL", values=form_extra)

    event_ids: list[int] = []
    refund_amount = Decimal("0")
    reversed_amount = Decimal("0")
    direct_cashflows = session.scalars(
        select(Cashflow)
        .where(
            Cashflow.order_id == order.id,
            Cashflow.category == "INSTALLMENT_PAYMENT",
            Cashflow.source_type == CashflowSourceType.INSTALLMENT.value,
        )
        .order_by(Cashflow.id)
    ).all()
    if direct_cashflows:
        reversed_cashflow_nos = set(
            session.scalars(
                select(Cashflow.source_id).where(
                    Cashflow.source_type == CashflowSourceType.REVERSAL.value,
                    Cashflow.source_id.in_([flow.flow_no for flow in direct_cashflows]),
                )
            ).all()
        )
        for flow in direct_cashflows:
            if flow.flow_no in reversed_cashflow_nos:
                continue
            reverse_cashflow(
                session,
                flow.id,
                reversed_on=cancelled_on,
                actor=actor,
                reason=text_reason,
                form_extra=None,
                user=user,
            )
            amount = to_money(flow.amount)
            refund_amount += amount
            reversed_amount += amount
            direct_cashflows = [flow for flow in direct_cashflows if flow.flow_no not in reversed_cashflow_nos]
    order.status = transition(ORDER_TRANSITIONS, order.status, "CANCEL", entity="订单")
    installment.status = transition(
        INSTALLMENT_TRANSITIONS, installment.status, "CANCEL", entity="分期合约"
    )
    account_status = apply_installment_cancellation_account_effect(
        session,
        order,
        contract_type=installment.contract_type,
        actor=actor,
    )
    installment.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.INSTALLMENT_CANCEL,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        after={
            "status": installment.status,
            "order_status": order.status,
            "account_status": account_status,
            "refund_amount": str(refund_amount),
            "reversed_amount": str(reversed_amount),
            "cancel_event_ids": event_ids,
        },
        reason=text_reason,
    )
    upsert_operation_operators(
        session,
        entity_type="installment",
        entity_id=installment.inst_no,
        operation_key="CANCEL",
        actor=actor,
        operator_user_ids=operator_user_ids,
    )
    return {
        "installment": installment,
        "order_status": order.status,
        "account_status": account_status,
        "refund_amount": refund_amount,
        "reversed_amount": reversed_amount,
        "cancel_event_ids": event_ids,
    }


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
    installment = get_installment(session, installment_id, user)
    _merge_form_extra(session, installment, scope="INSTWAIVE", values=form_extra)
    schedule = session.scalar(
        select(InstallmentSchedule).where(
            InstallmentSchedule.installment_id == installment.id,
            InstallmentSchedule.period_no == period_no,
        )
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
    installment = get_installment(session, installment_id, user)
    _merge_form_extra(session, installment, scope="INSTEXTEND", values=form_extra)
    schedule = session.scalar(
        select(InstallmentSchedule).where(
            InstallmentSchedule.installment_id == installment.id,
            InstallmentSchedule.period_no == period_no,
        )
    )
    if schedule is None:
        raise NotFound(f"期次 {period_no} 不存在", details={"period_no": period_no})
    if to_money(schedule.received_amount) > 0:
        raise Validation("已收期不可展期", details={"period_no": period_no})
    if schedule.status in {ScheduleStatus.PAID.value, ScheduleStatus.WAIVED.value}:
        raise Validation("已完成期次不可展期", details={"period_no": period_no})
    if new_due_on <= schedule.due_on:
        raise Validation("展期后的到期日必须晚于原到期日", details={"field": "new_due_on"})
    original_due_on = schedule.due_on
    schedule.due_on = new_due_on
    if schedule.status == ScheduleStatus.OVERDUE.value:
        schedule.status = ScheduleStatus.PENDING.value
    installment.updated_by = actor
    session.flush()
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


def _pick_schedule(
    session: Session, installment: Installment, period_no: int | None, paid_on: date
) -> InstallmentSchedule:
    if period_no is not None:
        schedule = session.scalar(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == installment.id,
                InstallmentSchedule.period_no == period_no,
            )
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
    ).first()
    if schedule is None:
        raise Validation(
            "所有期次已收满", code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE
        )
    return schedule
