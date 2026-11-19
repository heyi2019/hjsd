"""finance.cashflow_writes.create：独立现金流登记。"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import NotFound, Validation
from app.shared.numbering import allocate_flow_no
from app.core.security import CurrentUser
from app.domain.enums import (
    AuditAction,
    CashflowLedgerType,
    CashflowSourceType,
    Direction,
)
from app.domain.trade import Cashflow, OrderEvent
from app.funds.attributes import (
    accounting_attribute_for_manual_cashflow,
    assert_order_cost_attribute,
)
from app.settings.field_definitions.pools import assert_pool_usable
from app.shared.order_access import get_order
from app.shared.form_field_rules import validate_form_extra
from app.shared.form_values import set_extra_values
from app.funds._common import _positive, _text
from app.shared.operation_operators import validate_optional_operator_ids as _validate_operator_user_ids


def create_cashflow(
    session: Session,
    *,
    pool_id: int,
    occurred_on: date,
    direction: str,
    accounting_attribute: str | None = None,
    category: str,
    amount: Any,
    actor: str,
    ledger_type: str = CashflowLedgerType.BUSINESS.value,
    operator_user_ids: list[int] | None = None,
    order_id: int | None = None,
    source_type: str | None = None,
    source_id: str | None = None,
    note: str | None = None,
    extra_values: Mapping[str, Any] | None = None,
    form_extra: Mapping[str, Any] | None = None,
    form_extra_scope: str = "FUNDFLOW",
    user: CurrentUser | None = None,
) -> Cashflow:
    """创建一笔独立现金流；独立录入直接入账，业务派生流水不走此入口。"""
    try:
        direction = Direction(direction).value
    except ValueError as exc:
        raise Validation(
            f"direction 必须为 {Direction.values()}", details={"field": "direction"}
        ) from exc
    label = _text(
        category,
        field="category",
        message="category 不能为空",
        uppercase=True,
        type_message="category 必须为文本",
    )
    default_accounting_attribute = accounting_attribute_for_manual_cashflow(
        category=label, direction=direction,
        order_attached=order_id is not None,
    )
    accounting_attribute = accounting_attribute or default_accounting_attribute
    if user is not None and not user.can_see_pool(pool_id):
        raise NotFound("资金账户不存在", details={"pool_id": pool_id})
    pool = assert_pool_usable(session, pool_id)
    if order_id is not None:
        order = get_order(session, order_id, user)
        # 成本科目白名单：回收成本只归 HS、提号成本只归 TH，DG 两者皆禁（其余科目不设限）。
        assert_order_cost_attribute(order, accounting_attribute)
    try:
        normalized_ledger_type = CashflowLedgerType(ledger_type).value
    except ValueError as exc:
        raise Validation(
            f"ledger_type 必须为 {CashflowLedgerType.values()}",
            details={"field": "ledger_type", "value": ledger_type},
        ) from exc
    try:
        normalized_source_type = CashflowSourceType(
            source_type or CashflowSourceType.MANUAL.value
        ).value
    except ValueError as exc:
        raise Validation(
            f"source_type 必须为 {CashflowSourceType.values()}",
            details={"field": "source_type", "value": source_type},
        ) from exc
    if normalized_source_type == CashflowSourceType.ORDER_EVENT.value:
        if not source_id:
            raise Validation("订单事件流水必须填写 source_id")
        event = session.scalar(select(OrderEvent).where(OrderEvent.event_no == source_id))
        if event is None or (order_id is not None and event.order_id != order_id):
            raise Validation("资金明细关联的业务事件不存在或不属于该订单")
    elif normalized_source_type == CashflowSourceType.MANUAL.value and source_id is not None:
        raise Validation("手工流水不能填写 source_id")
    if normalized_ledger_type == CashflowLedgerType.STUDIO.value and (
        normalized_source_type != CashflowSourceType.MANUAL.value or order_id is not None
    ):
        raise Validation("工作室运营账簿必须是无订单归属的手工流水")
    money = _positive(amount, field="amount")
    operator_ids = _validate_operator_user_ids(session, operator_user_ids)
    flow = Cashflow(
        flow_no=allocate_flow_no(session, direction),
        pool_id=pool.id,
        occurred_on=occurred_on,
        ledger_type=normalized_ledger_type,
        accounting_attribute=accounting_attribute,
        category=label,
        direction=direction,
        amount=money,
        source_type=normalized_source_type,
        source_id=source_id,
        order_id=order_id,
        note=note,
        form_extra=validate_form_extra(
            session,
            order_type_code="STUDIOEXP" if normalized_ledger_type == CashflowLedgerType.STUDIO.value else form_extra_scope,
            values=form_extra,
        ) or None,
        created_by=actor,
        updated_by=actor,
        operator_user_ids=operator_ids,
    )
    session.add(flow)
    session.flush()
    set_extra_values(
        session,
        entity_type="cashflow",
        entity_id=flow.id,
        values=(extra_values or {}).items(),
        require_all=True,
    )
    record_audit(
        session,
        action=AuditAction.CASHFLOW_CREATE,
        entity_type="cashflow",
        entity_id=flow.flow_no,
        actor=actor,
        after={
            "pool_id": pool.id,
            "direction": direction,
            "amount": str(money),
        },
    )
    return flow
