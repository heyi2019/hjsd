"""finance 现金流写路径（FIN-04）：登记、冲销与工作室手工收支编辑。

查询层已拆至 `cashflow_queries.py`（2026-11-18 P2）；会计口径常量归位
`attributes.py`。本文件只保留产生/修改流水的写操作，全部走 Service 事务 +
record_audit 三件套。
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.time import now_second
from app.core.money import to_money
from app.core.numbering import allocate_flow_no
from app.core.security import CurrentUser
from app.domain.enums import (
    AccountingAttribute,
    AuditAction,
    CashflowLedgerType,
    CashflowSourceType,
    Direction,
    Nature,
)
from app.domain.trade import Cashflow, OrderEvent
from app.domain.users import User
from app.finance.attributes import (
    MANUAL_EXCLUDED_CATEGORIES,
    STUDIO_EXPENSE_ATTRIBUTE,
    STUDIO_INCOME_ATTRIBUTE,
    accounting_attribute_for_manual_cashflow,
    assert_order_cost_attribute,
    derive_manual_cashflow_nature,
)
from app.foundation.pools import assert_pool_usable
from app.orders._shared import get_order
from app.orders.form_fields import validate_form_extra
from app.parties.fields import set_extra_values

from ._common import _positive, _text


def _validate_operator_user_ids(
    session: Session, operator_user_ids: list[int] | None
) -> list[int] | None:
    """按订单事件/返点的口径校验资金登记操作人。"""
    if operator_user_ids is None:
        return None
    if len(set(operator_user_ids)) != len(operator_user_ids):
        raise Validation("操作人不能重复选择", details={"field": "operator_user_ids"})
    active_ids = set(
        session.scalars(
            select(User.id).where(User.id.in_(operator_user_ids), User.is_active.is_(True))
        )
    )
    if active_ids != set(operator_user_ids):
        raise Validation("所选操作人不存在或已停用", details={"field": "operator_user_ids"})
    return operator_user_ids


def _get_cashflow(
    session: Session, cashflow_id: int, user: CurrentUser | None = None
) -> Cashflow:
    flow = session.get(Cashflow, cashflow_id)
    if flow is None:
        raise NotFound(
            f"资金流水 {cashflow_id} 不存在", details={"cashflow_id": cashflow_id}
        )
    if user is not None and not user.can_see_pool(flow.pool_id):
        raise NotFound(
            f"资金流水 {cashflow_id} 不存在", details={"cashflow_id": cashflow_id}
        )
    if user is not None and flow.order_id is not None:
        get_order(session, flow.order_id, user)
    return flow


def create_cashflow(
    session: Session,
    *,
    pool_id: int,
    occurred_on: date,
    direction: str,
    nature: str | None = None,
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
    try:
        nature = Nature(
            nature or derive_manual_cashflow_nature(direction)
        ).value
    except ValueError as exc:
        raise Validation(
            f"nature 必须为 {Nature.values()}", details={"field": "nature"}
        ) from exc
    if nature == Nature.INTERNAL.value:
        raise Validation("独立现金流不能使用 INTERNAL，请使用池间划转")
    if direction == Direction.IN.value and nature not in {
        Nature.EXTERNAL_IN.value,
        Nature.BUSINESS_IN.value,
    }:
        raise Validation("收入流水的 nature 不匹配", details={"direction": direction, "nature": nature})
    if direction == Direction.OUT.value and nature != Nature.BUSINESS_OUT.value:
        raise Validation("支出流水的 nature 不匹配", details={"direction": direction, "nature": nature})
    label = _text(
        category,
        field="category",
        message="category 不能为空",
        uppercase=True,
        type_message="category 必须为文本",
    )
    default_accounting_attribute = accounting_attribute_for_manual_cashflow(
        nature=nature, category=label, direction=direction
    )
    accounting_attribute = accounting_attribute or default_accounting_attribute
    if nature == Nature.EXTERNAL_IN.value and (
        not isinstance(note, str) or not note.strip()
    ):
        raise Validation("独立收款必须填写摘要", details={"field": "note"})
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
        nature=nature,
        ledger_type=normalized_ledger_type,
        accounting_attribute=accounting_attribute,
        category=label,
        direction=direction,
        amount=money,
        source_type=normalized_source_type,
        source_id=source_id,
        order_id=order_id,
        note=note,
        form_extra=validate_form_extra(session, order_type_code=form_extra_scope, values=form_extra) or None,
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
            "nature": nature,
            "amount": str(money),
        },
    )
    return flow


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
        reverse_nature = Nature.BUSINESS_IN.value
    else:
        reverse_direction = Direction.OUT.value
        reverse_nature = Nature.BUSINESS_OUT.value
    reversal = Cashflow(
        flow_no=allocate_flow_no(session, reverse_direction),
        pool_id=flow.pool_id,
        occurred_on=reversed_on,
        nature=reverse_nature,
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


def _assert_editable_studio_cashflow(
    session: Session,
    cashflow_id: int,
    user: CurrentUser | None = None,
) -> Cashflow:
    flow = _get_cashflow(session, cashflow_id, user)
    if (
        flow.order_id is not None
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
    nature: str | None,
    accounting_attribute: str | None,
    category: str,
    amount: Any,
) -> tuple[str, str, str, str, str]:
    try:
        normalized_direction = Direction(direction).value
    except ValueError as exc:
        raise Validation(f"direction 必须为 {Direction.values()}", details={"field": "direction"}) from exc
    try:
        normalized_nature = Nature(
            nature or derive_manual_cashflow_nature(normalized_direction)
        ).value
    except ValueError as exc:
        raise Validation(f"nature 必须为 {Nature.values()}", details={"field": "nature"}) from exc
    if normalized_direction == Direction.IN.value and normalized_nature not in {
        Nature.EXTERNAL_IN.value,
        Nature.BUSINESS_IN.value,
    }:
        raise Validation("收入流水的 nature 不匹配", details={"direction": normalized_direction, "nature": normalized_nature})
    if normalized_direction == Direction.OUT.value and normalized_nature != Nature.BUSINESS_OUT.value:
        raise Validation("支出流水的 nature 不匹配", details={"direction": normalized_direction, "nature": normalized_nature})
    label = _text(
        category,
        field="category",
        message="category 不能为空",
        uppercase=True,
        type_message="category 必须为文本",
    )
    default_accounting_attribute = accounting_attribute_for_manual_cashflow(
        nature=normalized_nature, category=label, direction=normalized_direction
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
        normalized_nature,
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
    nature: str | None = None,
    accounting_attribute: str | None = None,
    category: str,
    amount: Any,
    note: str | None = None,
    form_extra: Mapping[str, Any] | None = None,
    form_extra_scope: str = "STUDIOEXP",
    actor: str,
    user: CurrentUser | None = None,
) -> Cashflow:
    flow = _assert_editable_studio_cashflow(session, cashflow_id, user)
    if user is not None and not user.can_see_pool(pool_id):
        raise NotFound("资金账户不存在", details={"pool_id": pool_id})
    pool = assert_pool_usable(session, pool_id)
    (
        normalized_direction,
        normalized_nature,
        normalized_accounting_attribute,
        label,
        money,
    ) = _normalize_studio_cashflow_fields(
        direction=direction,
        nature=nature,
        accounting_attribute=accounting_attribute,
        category=category,
        amount=amount,
    )
    before = {
        "pool_id": flow.pool_id,
        "occurred_on": flow.occurred_on.isoformat(),
        "direction": flow.direction,
        "nature": flow.nature,
        "accounting_attribute": flow.accounting_attribute,
        "category": flow.category,
        "amount": str(to_money(flow.amount)),
        "note": flow.note,
    }
    flow.pool_id = pool.id
    flow.occurred_on = occurred_on
    flow.direction = normalized_direction
    flow.nature = normalized_nature
    flow.accounting_attribute = normalized_accounting_attribute
    flow.category = label
    flow.amount = money
    flow.note = note
    flow.form_extra = validate_form_extra(session, order_type_code=form_extra_scope, values=form_extra) or None
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
            "nature": flow.nature,
            "accounting_attribute": flow.accounting_attribute,
            "category": flow.category,
            "amount": str(money),
            "note": note,
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


# P0-A（2026-11-18）：orders 创建订单时的初始成本挂账经协作注册点注入，
# 消灭 orders -> finance 反向依赖（backend/.importlinter 契约）。
# 本模块由 api_v1 -> finance_router -> cashflows_router 链路必然加载，注册随之生效。
from app.orders.collaboration import register_cost_flow_creator

register_cost_flow_creator(create_cashflow)

__all__ = [
    "create_cashflow",
    "delete_cashflow",
    "reverse_cashflow",
    "update_cashflow",
]
