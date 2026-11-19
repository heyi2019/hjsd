"""installments.repayments.cancel：取消与冲销（BAS-03，从 repayment.py 逐字拆出）。"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from decimal import Decimal
from typing import Any
from app.shared.audit import record_audit
from app.core.security import CurrentUser
from app.domain.enums import CashflowSourceType
from app.funds.cashflows import reverse_cashflow
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import Conflict, ErrorCode, NotFound
from app.core.money import to_money
from app.shared.operation_operators import upsert_operation_operators
from app.core.state_machine import INSTALLMENT_TRANSITIONS, ORDER_TRANSITIONS, transition
from app.business.cancellation_model import apply_installment_cancellation_account_effect
from app.domain.enums import AuditAction, InstallmentStatus
from app.domain.trade import Order, Cashflow
from .._shared import _merge_form_extra, _required_text, get_installment

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
