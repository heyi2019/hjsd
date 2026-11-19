"""finance.cashflow_writes.studio：工作室手工收支的编辑与删除。"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.enums import AuditAction, CashflowLedgerType, CashflowSourceType, Direction
from app.domain.trade import Cashflow
from app.funds.attributes import (
    MANUAL_EXCLUDED_CATEGORIES,
    STUDIO_EXPENSE_ATTRIBUTE,
    STUDIO_INCOME_ATTRIBUTE,
)
from app.settings.field_definitions.pools import assert_pool_usable
from app.shared.form_field_rules import validate_form_extra
from app.shared.operation_operators import validate_optional_operator_ids
from app.funds._common import _positive, _text
from app.funds.cashflow_writes._shared import _get_cashflow


def _assert_editable_studio_cashflow(
    session: Session,
    cashflow_id: int,
    user: CurrentUser | None = None,
) -> Cashflow:
    flow = _get_cashflow(session, cashflow_id, user, for_update=True)
    if (
        flow.ledger_type != CashflowLedgerType.STUDIO.value
        or flow.order_id is not None
        or flow.source_type != CashflowSourceType.MANUAL.value
        or flow.category in MANUAL_EXCLUDED_CATEGORIES
        or not (
            (flow.direction == Direction.OUT.value and flow.accounting_attribute == STUDIO_EXPENSE_ATTRIBUTE)
            or (flow.direction == Direction.IN.value and flow.accounting_attribute == STUDIO_INCOME_ATTRIBUTE)
        )
    ):
        raise Validation("仅工作室手工收支可编辑或删除", details={"cashflow_id": flow.id})
    if session.scalar(
        select(Cashflow.id).where(
            Cashflow.source_type == CashflowSourceType.REVERSAL.value,
            Cashflow.source_id == flow.flow_no,
        )
    ):
        raise Validation("已冲销的工作室收支不能编辑或删除", details={"cashflow_id": flow.id})
    return flow


def _normalize_studio_cashflow_fields(
    *,
    direction: str,
    accounting_attribute: str | None,
    category: str,
    amount: Any,
) -> tuple[str, str, str, str]:
    try:
        normalized_direction = Direction(direction).value
    except ValueError as exc:
        raise Validation(f"direction 必须为 {Direction.values()}", details={"field": "direction"}) from exc
    label = _text(
        category,
        field="category",
        message="category 不能为空",
        uppercase=True,
        type_message="category 必须为文本",
    )
    default_accounting_attribute = (
        STUDIO_EXPENSE_ATTRIBUTE if normalized_direction == Direction.OUT.value else STUDIO_INCOME_ATTRIBUTE
    )
    normalized_accounting_attribute = accounting_attribute or default_accounting_attribute
    if normalized_direction == Direction.OUT.value and normalized_accounting_attribute != STUDIO_EXPENSE_ATTRIBUTE:
        raise Validation("工作室支出必须使用运营费用科目", details={"field": "accounting_attribute"})
    if normalized_direction == Direction.IN.value and normalized_accounting_attribute != STUDIO_INCOME_ATTRIBUTE:
        raise Validation("工作室收入必须使用回收收入科目", details={"field": "accounting_attribute"})
    if label in MANUAL_EXCLUDED_CATEGORIES:
        raise Validation("该科目不属于工作室手工收支", details={"field": "category"})
    return (
        normalized_direction,
        normalized_accounting_attribute,
        label,
        _positive(amount, field="amount"),
    )


def update_cashflow(
    session: Session,
    cashflow_id: int,
    *,
    pool_id: int,
    occurred_on: date,
    direction: str,
    accounting_attribute: str | None = None,
    category: str,
    amount: Any,
    note: str | None = None,
    operator_user_ids: list[int] | None = None,
    form_extra: Mapping[str, Any] | None = None,
    actor: str,
    user: CurrentUser | None = None,
) -> Cashflow:
    flow = _assert_editable_studio_cashflow(session, cashflow_id, user)
    if user is not None and not user.can_see_pool(pool_id):
        raise NotFound("资金账户不存在", details={"pool_id": pool_id})
    pool = assert_pool_usable(session, pool_id)
    (
        normalized_direction,
        normalized_accounting_attribute,
        label,
        money,
    ) = _normalize_studio_cashflow_fields(
        direction=direction,
        accounting_attribute=accounting_attribute,
        category=category,
        amount=amount,
    )
    operator_ids = validate_optional_operator_ids(session, operator_user_ids)
    before = {
        "pool_id": flow.pool_id,
        "occurred_on": flow.occurred_on.isoformat(),
        "direction": flow.direction,
        "accounting_attribute": flow.accounting_attribute,
        "category": flow.category,
        "amount": str(to_money(flow.amount)),
        "note": flow.note,
        "operator_user_ids": flow.operator_user_ids,
    }
    flow.pool_id = pool.id
    flow.occurred_on = occurred_on
    flow.direction = normalized_direction
    flow.accounting_attribute = normalized_accounting_attribute
    flow.category = label
    flow.amount = money
    flow.note = note
    if operator_ids is not None:
        flow.operator_user_ids = operator_ids
    flow.form_extra = validate_form_extra(session, order_type_code="STUDIOEXP", values=form_extra) or None
    flow.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.CASHFLOW_UPDATE,
        entity_type="cashflow",
        entity_id=flow.flow_no,
        actor=actor,
        before=before,
        after={
            "pool_id": flow.pool_id,
            "occurred_on": occurred_on.isoformat(),
            "direction": flow.direction,
            "accounting_attribute": flow.accounting_attribute,
            "category": flow.category,
            "amount": str(money),
            "note": note,
            "operator_user_ids": flow.operator_user_ids,
        },
    )
    return flow


def delete_cashflow(
    session: Session,
    cashflow_id: int,
    *,
    actor: str,
    user: CurrentUser | None = None,
) -> None:
    flow = _assert_editable_studio_cashflow(session, cashflow_id, user)
    before = {
        "pool_id": flow.pool_id,
        "occurred_on": flow.occurred_on.isoformat(),
        "direction": flow.direction,
        "category": flow.category,
        "amount": str(to_money(flow.amount)),
    }
    flow_no = flow.flow_no
    session.delete(flow)
    session.flush()
    record_audit(
        session,
        action=AuditAction.CASHFLOW_DELETE,
        entity_type="cashflow",
        entity_id=flow_no,
        actor=actor,
        before=before,
        after={"deleted": True},
    )
