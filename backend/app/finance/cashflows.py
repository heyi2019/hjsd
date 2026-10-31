"""finance 现金流服务（FIN-04）：登记、冲销与查询。"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.money import to_money
from app.core.numbering import allocate_flow_no
from app.core.security import CurrentUser, owner_scope_filter
from app.domain.enums import (
    AccountingAttribute,
    AuditAction,
    CashflowStatus,
    Direction,
    Nature,
)
from app.domain.trade import Cashflow, Order
from app.finance.attributes import (
    accounting_attributes_for_manual_cashflow,
    validate_fund_accounting_attribute,
)
from app.foundation import service as foundation_service
from app.orders import service as orders_service
from app.orders.form_fields import validate_form_extra
from app.parties import service as parties_service

from ._common import _positive, _text


# 兼容层：押金服务迁至 deposits.py，此处保留原路径导出
from .deposits import (
    cancel_deposit,
    create_deposit,
    list_deposits,
    lose_deposit,
    return_deposit,
)

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
        orders_service.get_order(session, flow.order_id, user)
    return flow


def create_cashflow(
    session: Session,
    *,
    pool_id: int,
    occurred_on: date,
    direction: str,
    nature: str,
    fund_nature: str | None = None,
    accounting_attribute: str | None = None,
    category: str,
    amount: Any,
    actor: str,
    order_id: int | None = None,
    note: str | None = None,
    extra_values: Mapping[str, Any] | None = None,
    form_extra: Mapping[str, Any] | None = None,
    form_extra_scope: str = "FUNDFLOW",
    user: CurrentUser | None = None,
) -> Cashflow:
    """创建一笔独立现金流；独立录入必须先审核，业务派生流水不走此入口。"""
    try:
        direction = Direction(direction).value
    except ValueError as exc:
        raise Validation(
            f"direction 必须为 {Direction.values()}", details={"field": "direction"}
        ) from exc
    try:
        nature = Nature(nature).value
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
    default_fund_nature, default_accounting_attribute = (
        accounting_attributes_for_manual_cashflow(
            nature=nature, category=label, direction=direction
        )
    )
    fund_nature = fund_nature or default_fund_nature
    accounting_attribute = accounting_attribute or default_accounting_attribute
    try:
        validate_fund_accounting_attribute(fund_nature, accounting_attribute)
    except ValueError as exc:
        raise Validation(str(exc), details={"fund_nature": fund_nature, "accounting_attribute": accounting_attribute}) from exc
    if nature == Nature.EXTERNAL_IN.value and (
        not isinstance(note, str) or not note.strip()
    ):
        raise Validation("独立收款必须填写摘要", details={"field": "note"})
    if user is not None and not user.can_see_pool(pool_id):
        raise NotFound("资金池不存在", details={"pool_id": pool_id})
    pool = foundation_service.assert_pool_usable(session, pool_id)
    if order_id is not None:
        orders_service.get_order(session, order_id, user)
    money = _positive(amount, field="amount")
    flow = Cashflow(
        flow_no=allocate_flow_no(session, direction),
        pool_id=pool.id,
        occurred_on=occurred_on,
        nature=nature,
        fund_nature=fund_nature,
        accounting_attribute=accounting_attribute,
        category=label,
        direction=direction,
        amount=money,
        order_id=order_id,
        status=CashflowStatus.APPROVED.value,
        note=note,
        form_extra=validate_form_extra(session, order_type_code=form_extra_scope, values=form_extra) or None,
        created_by=actor,
        updated_by=actor,
    )
    session.add(flow)
    session.flush()
    parties_service.set_extra_values(
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
            "status": flow.status,
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
    user: CurrentUser | None = None,
) -> Cashflow:
    text_reason = _text(
        reason,
        field="reason",
        message="冲销流水必须填写原因",
        type_message="冲销流水必须填写原因",
    )
    flow = _get_cashflow(session, cashflow_id, user)
    if flow.status != CashflowStatus.APPROVED.value:
        raise Validation("只有已审核流水可以冲销", details={"cashflow_id": cashflow_id})
    if flow.order_event_id is not None:
        raise Validation("业务事件现金流必须通过业务事件冲销")
    if flow.deposit_id is not None or flow.transfer_id is not None:
        raise Validation("押金或划转现金流必须通过原业务流程冲销")
    if session.scalar(select(Cashflow.id).where(Cashflow.reversal_of_id == flow.id)):
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
        fund_nature=flow.fund_nature,
        accounting_attribute=AccountingAttribute.REVERSAL.value,
        category="REVERSAL",
        direction=reverse_direction,
        amount=to_money(flow.amount),
        order_id=flow.order_id,
        status=CashflowStatus.APPROVED.value,
        reversal_of_id=flow.id,
        reversal_reason=text_reason,
        note=f"冲销 {flow.flow_no}",
        form_extra=validate_form_extra(session, order_type_code=form_extra_scope, values=form_extra) or None,
        reviewed_by=actor,
        reviewed_at=datetime.now(),
        created_by=actor,
        updated_by=actor,
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


def list_cashflows(
    session: Session,
    *,
    pool_id: int | None = None,
    pool_ids: Iterable[int] | None = None,
    order_id: int | None = None,
    direction: str | None = None,
    occurred_from: date | None = None,
    occurred_to: date | None = None,
    status: str | None = None,
    nature: str | None = None,
    fund_nature: str | None = None,
    accounting_attribute: str | None = None,
    category: str | None = None,
    created_by: str | None = None,
    limit: int = 100,
    offset: int = 0,
    user: CurrentUser | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """统一查询资金明细，直接返回订单号，避免前端按日期和金额猜来源。

    返回 (本页明细, 命中总数)；总数用于前端判断是否还有更多数据。
    """
    stmt = (
        select(Cashflow, Order.order_no)
        .outerjoin(Order, Order.id == Cashflow.order_id)
    )
    if pool_id is not None:
        if user is not None and not user.can_see_pool(pool_id):
            return []
        stmt = stmt.where(Cashflow.pool_id == pool_id)
    elif pool_ids is not None:
        visible_pool_ids = list(pool_ids)
        if user is not None and not (user.is_admin or user.owner_scope == "ALL"):
            visible_pool_ids = [pool for pool in visible_pool_ids if user.can_see_pool(pool)]
        stmt = stmt.where(Cashflow.pool_id.in_(visible_pool_ids))
    elif user is not None and not (user.is_admin or user.owner_scope == "ALL"):
        stmt = stmt.where(Cashflow.pool_id.in_(sorted(user.pool_ids)))
    if order_id is not None:
        stmt = stmt.where(Cashflow.order_id == order_id)
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(Cashflow.order_id.is_(None) | scope)
    if direction is not None:
        stmt = stmt.where(Cashflow.direction == direction)
    if occurred_from is not None:
        stmt = stmt.where(Cashflow.occurred_on >= occurred_from)
    if occurred_to is not None:
        stmt = stmt.where(Cashflow.occurred_on <= occurred_to)
    if status is not None:
        try:
            status = CashflowStatus(status).value
        except ValueError as exc:
            raise Validation(
                f"status 必须为 {CashflowStatus.values()}",
                details={"field": "status", "value": status},
            ) from exc
        stmt = stmt.where(Cashflow.status == status)
    if nature is not None:
        stmt = stmt.where(Cashflow.nature == nature)
    if fund_nature is not None:
        stmt = stmt.where(Cashflow.fund_nature == fund_nature)
    if accounting_attribute is not None:
        stmt = stmt.where(Cashflow.accounting_attribute == accounting_attribute)
    if category is not None:
        stmt = stmt.where(Cashflow.category == category)
    if created_by is not None:
        stmt = stmt.where(Cashflow.created_by == created_by)

    total = session.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows: list[dict[str, Any]] = []
    for flow, order_no in session.execute(
        stmt.order_by(Cashflow.occurred_on.desc(), Cashflow.id.desc())
        .limit(limit)
        .offset(offset)
    ).all():
        if flow.order_event_id is not None:
            source = "ORDER_EVENT"
        elif flow.category in {"REBATE", "REBATE_REVERSAL"}:
            source = "REBATE_SETTLEMENT"
        elif flow.deposit_id is not None or flow.category in {
            "DEPOSIT_HOLD",
            "DEPOSIT_RELEASE",
            "DEPOSIT_LOSS",
        }:
            source = "DEPOSIT"
        elif flow.category == "TRANSFER":
            source = "TRANSFER"
        else:
            source = "OTHER"
        rows.append(
            {
                "id": flow.id,
                "flow_no": flow.flow_no,
                "pool_id": flow.pool_id,
                "occurred_on": flow.occurred_on,
                "occurred_at": flow.created_at,
                "nature": flow.nature,
                "fund_nature": flow.fund_nature,
                "accounting_attribute": flow.accounting_attribute,
                "category": flow.category,
                "direction": flow.direction,
                "amount": flow.amount,
                "status": flow.status,
                "reviewed_by": flow.reviewed_by,
                "reviewed_at": flow.reviewed_at,
                "reversal_of_id": flow.reversal_of_id,
                "order_id": flow.order_id,
                "order_no": order_no,
                "deposit_id": flow.deposit_id,
                "order_event_id": flow.order_event_id,
                "transfer_id": flow.transfer_id,
                "source": source,
                "note": flow.note,
                "operator": flow.created_by,
            }
        )
    extras = parties_service.get_extra_values_bulk(
        session, entity_type="cashflow", entity_ids=[row["id"] for row in rows]
    )
    for row in rows:
        row["extra_values"] = extras.get(row["id"], {})
    return rows, total

__all__ = [
    "cancel_deposit",
    "create_cashflow",
    "create_deposit",
    "list_cashflows",
    "list_deposits",
    "lose_deposit",
    "return_deposit",
    "reverse_cashflow",
]
