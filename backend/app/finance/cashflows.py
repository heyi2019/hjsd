"""finance 现金流与押金服务（FIN-04）。"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.core.numbering import allocate_number
from app.core.periods import assert_period_open, normalize_period
from app.core.security import CurrentUser, owner_scope_filter
from app.domain.enums import (
    AuditAction,
    CashflowStatus,
    DepositStatus,
    Direction,
    Nature,
    SequenceKey,
)
from app.domain.foundation import PeriodLock
from app.domain.trade import Cashflow, Deposit, Order
from app.foundation import service as foundation_service
from app.orders import service as orders_service
from app.parties import service as parties_service

from ._common import _non_negative, _positive, _text

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


def create_period_lock(
    session: Session, *, period: str, actor: str, note: str | None = None
) -> PeriodLock:
    normalized = normalize_period(period)
    if session.scalar(select(PeriodLock).where(PeriodLock.period == normalized)) is not None:
        raise Conflict(
            f"账期 {normalized} 已锁定",
            code=ErrorCode.DUPLICATE_CODE,
            details={"period": normalized},
        )
    item = PeriodLock(
        period=normalized,
        locked_by=actor,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(item)
    session.flush()
    record_audit(
        session,
        action=AuditAction.PERIOD_LOCK,
        entity_type="period_lock",
        entity_id=normalized,
        actor=actor,
        after={"period": normalized, "locked_by": actor},
    )
    return item


def list_period_locks(session: Session) -> list[PeriodLock]:
    return list(session.scalars(select(PeriodLock).order_by(PeriodLock.period.desc())).all())


def create_cashflow(
    session: Session,
    *,
    pool_id: int,
    occurred_on: date,
    direction: str,
    nature: str,
    category: str,
    amount: Any,
    actor: str,
    order_id: int | None = None,
    note: str | None = None,
    extra_values: Mapping[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> Cashflow:
    """创建一笔独立现金流；独立录入必须先审核，业务派生流水不走此入口。"""
    assert_period_open(session, occurred_on, operation="创建现金流")
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
        flow_no=allocate_number(session, SequenceKey.CASHFLOW.value),
        pool_id=pool.id,
        occurred_on=occurred_on,
        nature=nature,
        category=label,
        direction=direction,
        amount=money,
        order_id=order_id,
        status=CashflowStatus.PENDING.value,
        note=note,
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


def approve_cashflow(
    session: Session,
    cashflow_id: int,
    *,
    actor: str,
    user: CurrentUser | None = None,
) -> Cashflow:
    flow = _get_cashflow(session, cashflow_id, user)
    assert_period_open(session, flow.occurred_on, operation="审核历史流水")
    if flow.status != CashflowStatus.PENDING.value:
        raise Validation(
            "只有待审核流水可以审核",
            details={"cashflow_id": cashflow_id, "status": flow.status},
        )
    flow.status = CashflowStatus.APPROVED.value
    flow.reviewed_by = actor
    flow.reviewed_at = datetime.now()
    flow.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.CASHFLOW_APPROVE,
        entity_type="cashflow",
        entity_id=flow.flow_no,
        actor=actor,
        after={"status": flow.status},
    )
    return flow


def reject_cashflow(
    session: Session,
    cashflow_id: int,
    *,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
) -> Cashflow:
    text_reason = _text(
        reason,
        field="reason",
        message="驳回流水必须填写原因",
        type_message="驳回流水必须填写原因",
    )
    flow = _get_cashflow(session, cashflow_id, user)
    assert_period_open(session, flow.occurred_on, operation="驳回历史流水")
    if flow.status != CashflowStatus.PENDING.value:
        raise Validation(
            "只有待审核流水可以驳回",
            details={"cashflow_id": cashflow_id, "status": flow.status},
        )
    flow.status = CashflowStatus.REJECTED.value
    flow.reviewed_by = actor
    flow.reviewed_at = datetime.now()
    flow.reversal_reason = text_reason
    flow.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.CASHFLOW_REJECT,
        entity_type="cashflow",
        entity_id=flow.flow_no,
        actor=actor,
        after={"status": flow.status, "reason": text_reason},
    )
    return flow


def reverse_cashflow(
    session: Session,
    cashflow_id: int,
    *,
    reversed_on: date,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
) -> Cashflow:
    text_reason = _text(
        reason,
        field="reason",
        message="冲销流水必须填写原因",
        type_message="冲销流水必须填写原因",
    )
    flow = _get_cashflow(session, cashflow_id, user)
    assert_period_open(session, reversed_on, operation="创建冲销流水")
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
        flow_no=allocate_number(session, SequenceKey.CASHFLOW.value),
        pool_id=flow.pool_id,
        occurred_on=reversed_on,
        nature=reverse_nature,
        category="REVERSAL",
        direction=reverse_direction,
        amount=to_money(flow.amount),
        order_id=flow.order_id,
        status=CashflowStatus.APPROVED.value,
        reversal_of_id=flow.id,
        reversal_reason=text_reason,
        note=f"冲销 {flow.flow_no}",
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


# --------------------------------------------------------------------- 押金
def create_deposit(
    session: Session,
    *,
    pool_id: int,
    amount: Any,
    paid_on: date,
    actor: str,
    counterparty_id: int | None = None,
    source_order_id: int | None = None,
    expected_release_on: date | None = None,
    note: str | None = None,
    user: CurrentUser | None = None,
) -> Deposit:
    assert_period_open(session, paid_on, operation="创建押金流水")
    money = _positive(amount, field="amount")
    if user is not None and not user.can_see_pool(pool_id):
        raise NotFound("资金池不存在", details={"pool_id": pool_id})
    pool = foundation_service.assert_pool_usable(session, pool_id)
    if counterparty_id is not None:
        parties_service.assert_counterparty_usable(session, counterparty_id)
    if source_order_id is not None:
        try:
            orders_service.get_order(session, source_order_id, user)
        except NotFound as exc:
            raise NotFound(
                f"来源订单 {source_order_id} 不存在",
                details={"source_order_id": source_order_id},
            ) from exc
    deposit = Deposit(
        pool_id=pool.id,
        counterparty_id=counterparty_id,
        source_order_id=source_order_id,
        paid_amount=money,
        returned_amount=Decimal("0"),
        lost_amount=Decimal("0"),
        status=DepositStatus.PAID.value,
        paid_on=paid_on,
        expected_release_on=expected_release_on,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(deposit)
    session.flush()
    session.add(
        Cashflow(
            flow_no=allocate_number(session, SequenceKey.CASHFLOW),
            pool_id=pool.id,
            occurred_on=paid_on,
            nature=Nature.BUSINESS_OUT.value,
            category="DEPOSIT_HOLD",
            direction=Direction.OUT.value,
            amount=money,
            order_id=source_order_id,
            deposit_id=deposit.id,
            note="押金占用",
            created_by=actor,
            updated_by=actor,
        )
    )
    session.flush()
    record_audit(
        session,
        action=AuditAction.DEPOSIT_CREATE,
        entity_type="deposit",
        entity_id=str(deposit.id),
        actor=actor,
        after={"pool": pool.code, "amount": str(money)},
    )
    return deposit


def return_deposit(
    session: Session,
    deposit_id: int,
    *,
    amount: Any,
    released_on: date,
    actor: str,
    user: CurrentUser | None = None,
) -> Deposit:
    deposit = session.get(Deposit, deposit_id)
    if deposit is None:
        raise NotFound(f"押金 {deposit_id} 不存在", details={"deposit_id": deposit_id})
    if user is not None and not user.can_see_pool(deposit.pool_id):
        raise NotFound(f"押金 {deposit_id} 不存在", details={"deposit_id": deposit_id})
    assert_period_open(session, released_on, operation="释放押金")
    money = _positive(amount, field="amount")
    outstanding = (
        to_money(deposit.paid_amount)
        - to_money(deposit.returned_amount)
        - to_money(deposit.lost_amount)
    )
    if money > outstanding:
        raise Validation(
            "退还金额超过未释放余额",
            code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE,
            details={"deposit_id": deposit.id, "outstanding": str(outstanding)},
        )

    deposit.returned_amount = to_money(deposit.returned_amount) + money
    deposit.released_on = released_on
    if to_money(deposit.returned_amount) + to_money(deposit.lost_amount) >= to_money(
        deposit.paid_amount
    ):
        deposit.status = (
            DepositStatus.LOST.value
            if to_money(deposit.lost_amount) > 0
            else DepositStatus.RETURNED.value
        )
    else:
        deposit.status = DepositStatus.PARTIALLY_RETURNED.value
    deposit.updated_by = actor
    session.add(
        Cashflow(
            flow_no=allocate_number(session, SequenceKey.CASHFLOW),
            pool_id=deposit.pool_id,
            occurred_on=released_on,
            nature=Nature.BUSINESS_IN.value,
            category="DEPOSIT_RELEASE",
            direction=Direction.IN.value,
            amount=money,
            order_id=deposit.source_order_id,
            deposit_id=deposit.id,
            note="押金释放",
            created_by=actor,
            updated_by=actor,
        )
    )
    session.flush()
    record_audit(
        session,
        action=AuditAction.DEPOSIT_RELEASE,
        entity_type="deposit",
        entity_id=str(deposit.id),
        actor=actor,
        after={
            "returned": str(to_money(deposit.returned_amount)),
            "status": deposit.status,
        },
    )
    return deposit


def lose_deposit(
    session: Session,
    deposit_id: int,
    *,
    amount: Any,
    lost_on: date,
    category: str,
    reason: str,
    actor: str,
    user: CurrentUser | None = None,
) -> Cashflow:
    """把未释放押金转为受控运营费用，押金占用同步减少。"""
    deposit = session.get(Deposit, deposit_id)
    if deposit is None or (user is not None and not user.can_see_pool(deposit.pool_id)):
        raise NotFound(f"押金 {deposit_id} 不存在", details={"deposit_id": deposit_id})
    assert_period_open(session, lost_on, operation="登记押金损失")
    text_reason = _text(
        reason,
        field="reason",
        message="押金损失必须填写原因",
        type_message="押金损失必须填写原因",
    )
    label = _text(
        category,
        field="category",
        message="押金损失必须填写费用分类",
        uppercase=True,
        type_message="押金损失必须填写费用分类",
    )
    if label in {"DEPOSIT_HOLD", "DEPOSIT_RELEASE", "DEPOSIT_LOSS", "TRANSFER"}:
        raise Validation("押金损失费用分类不能使用系统分类", details={"field": "category"})
    money = _positive(amount, field="amount")
    outstanding = (
        to_money(deposit.paid_amount)
        - to_money(deposit.returned_amount)
        - to_money(deposit.lost_amount)
    )
    if money > outstanding:
        raise Validation(
            "损失金额超过未释放余额",
            code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE,
            details={"deposit_id": deposit.id, "outstanding": str(outstanding)},
        )
    deposit.lost_amount = to_money(deposit.lost_amount) + money
    deposit.lost_on = lost_on
    if (
        to_money(deposit.returned_amount) + to_money(deposit.lost_amount)
        >= to_money(deposit.paid_amount)
    ):
        deposit.status = DepositStatus.LOST.value
    deposit.updated_by = actor
    flow = Cashflow(
        flow_no=allocate_number(session, SequenceKey.CASHFLOW),
        pool_id=deposit.pool_id,
        occurred_on=lost_on,
        nature=Nature.BUSINESS_OUT.value,
        category=label,
        direction=Direction.OUT.value,
        amount=money,
        order_id=deposit.source_order_id,
        deposit_id=deposit.id,
        status=CashflowStatus.APPROVED.value,
        reviewed_by=actor,
        reviewed_at=datetime.now(),
        note=text_reason,
        created_by=actor,
        updated_by=actor,
    )
    session.add(flow)
    session.flush()
    record_audit(
        session,
        action=AuditAction.DEPOSIT_LOSS,
        entity_type="deposit",
        entity_id=str(deposit.id),
        actor=actor,
        after={
            "amount": str(money),
            "category": label,
            "lost_amount": str(deposit.lost_amount),
            "status": deposit.status,
        },
        reason=text_reason,
    )
    return flow


def list_deposits(
    session: Session,
    *,
    pool_id: int | None = None,
    pool_ids: Iterable[int] | None = None,
    user: CurrentUser | None = None,
) -> list[Deposit]:
    stmt = select(Deposit)
    if pool_id is not None:
        if user is not None and not user.can_see_pool(pool_id):
            return []
        stmt = stmt.where(Deposit.pool_id == pool_id)
    elif pool_ids is not None:
        visible_pool_ids = list(pool_ids)
        if user is not None and not (user.is_admin or user.owner_scope == "ALL"):
            visible_pool_ids = [pool for pool in visible_pool_ids if user.can_see_pool(pool)]
        stmt = stmt.where(Deposit.pool_id.in_(visible_pool_ids))
    elif user is not None and not (user.is_admin or user.owner_scope == "ALL"):
        stmt = stmt.where(Deposit.pool_id.in_(sorted(user.pool_ids)))
    return list(session.scalars(stmt.order_by(Deposit.id)).all())


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
    limit: int = 100,
    offset: int = 0,
    user: CurrentUser | None = None,
) -> list[dict[str, Any]]:
    """统一查询资金明细，直接返回订单号，避免前端按日期和金额猜来源。"""
    stmt = (
        select(Cashflow, Order.order_no)
        .outerjoin(Order, Order.id == Cashflow.order_id)
        .order_by(Cashflow.occurred_on.desc(), Cashflow.id.desc())
        .limit(limit)
        .offset(offset)
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

    rows: list[dict[str, Any]] = []
    for flow, order_no in session.execute(stmt).all():
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
    return rows

__all__ = [
    "approve_cashflow",
    "create_cashflow",
    "create_deposit",
    "create_period_lock",
    "list_cashflows",
    "list_deposits",
    "list_period_locks",
    "lose_deposit",
    "reject_cashflow",
    "return_deposit",
    "reverse_cashflow",
]

