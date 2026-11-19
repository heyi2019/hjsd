"""finance.cashflow_writes.reverse：流水冲销。"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import Validation
from app.core.time import now_second
from app.core.money import to_money
from app.shared.numbering import allocate_flow_no
from app.core.security import CurrentUser
from app.domain.enums import (
    AccountingAttribute,
    AuditAction,
    CashflowSourceType,
    Direction,
)
from app.domain.trade import Cashflow, OrderEvent
from app.shared.form_field_rules import validate_form_extra
from app.finance._common import _text
from app.finance.cashflow_writes._shared import _get_cashflow
from app.shared.operation_operators import validate_optional_operator_ids as _validate_operator_user_ids


def reverse_cashflow(
    session: Session,
    cashflow_id: int,
    *,
    reversed_on: date,
    actor: str,
    reason: str,
    form_extra: Mapping[str, Any] | None = None,
    form_extra_scope: str = "FUNDREVERSE",
    operator_user_ids: list[int] | None = None,
    user: CurrentUser | None = None,
) -> Cashflow:
    text_reason = _text(
        reason,
        field="reason",
        message="冲销流水必须填写原因",
        type_message="冲销流水必须填写原因",
    )
    flow = _get_cashflow(session, cashflow_id, user)
    if flow.source_type == CashflowSourceType.ORDER_EVENT.value:
        event = session.scalar(select(OrderEvent).where(OrderEvent.event_no == flow.source_id))
        if event is None or event.event_type not in {"REBATE"}:
            raise Validation("业务事件现金流必须通过业务事件冲销")
    if flow.source_type in {
        CashflowSourceType.DEPOSIT.value,
        CashflowSourceType.TRANSFER.value,
    }:
        raise Validation("押金或划转现金流必须通过原业务流程冲销")
    if session.scalar(
        select(Cashflow.id).where(
            Cashflow.source_type == CashflowSourceType.REVERSAL.value,
            Cashflow.source_id == flow.flow_no,
        )
    ):
        raise Validation("该流水已冲销", details={"cashflow_id": cashflow_id})

    if flow.direction == Direction.OUT.value:
        reverse_direction = Direction.IN.value
    else:
        reverse_direction = Direction.OUT.value
    reversal = Cashflow(
        flow_no=allocate_flow_no(session, reverse_direction),
        pool_id=flow.pool_id,
        occurred_on=reversed_on,
        # 继承原流水账簿：工作室手工收支（STUDIO）的冲销必须留在工作室账簿，
        # 否则 studio-summary 按 ledger_type=STUDIO 过滤时会漏掉冲销、净额虚高。
        # 业务账簿流水继承 BUSINESS，与原行为一致，无副作用。
        ledger_type=flow.ledger_type,
        accounting_attribute=AccountingAttribute.REVERSAL.value,
        category="REVERSAL",
        direction=reverse_direction,
        amount=to_money(flow.amount),
        source_type=CashflowSourceType.REVERSAL.value,
        source_id=flow.flow_no,
        order_id=flow.order_id,
        reversal_reason=text_reason,
        note=f"冲销 {flow.flow_no}",
        form_extra=validate_form_extra(session, order_type_code=form_extra_scope, values=form_extra) or None,
        reviewed_by=actor,
        reviewed_at=now_second(),
        created_by=actor,
        updated_by=actor,
        operator_user_ids=_validate_operator_user_ids(session, operator_user_ids),
    )
    session.add(reversal)
    session.flush()
    record_audit(
        session,
        action=AuditAction.CASHFLOW_REVERSE,
        entity_type="cashflow",
        entity_id=reversal.flow_no,
        actor=actor,
        after={"reversal_of": flow.flow_no, "amount": str(reversal.amount)},
        reason=text_reason,
    )
    return reversal
