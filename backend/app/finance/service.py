"""finance.service：押金与返点（FIN-04 / REB-01）。

- 押金不进损益，只改变可用余额；缴退都必须有现金流（A08）；
- 返点记录必须关联来源订单，分次到账使用订单从属号，净额 = 毛额 − 手续费（A06）。
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from collections.abc import Iterable
from typing import Any
from uuid import uuid4

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.business_numbering import rebate_no as order_rebate_no
from app.core.business_numbering import rebate_settlement_no
from app.core.errors import NotFound, Validation
from app.core.errors import ErrorCode
from app.core.money import require_non_negative, require_positive, to_money
from app.core.numbering import allocate_number
from app.core.security import CurrentUser, owner_scope_filter
from app.policy import service as policy_service
from app.domain.enums import (
    AuditAction,
    CashflowStatus,
    DepositStatus,
    Direction,
    EventType,
    Nature,
    OrderStatus,
    PolicyType,
    RebateType,
    RebateStatus,
    ReconciliationStatus,
    SequenceKey,
)
from app.domain.trade import (
    Cashflow,
    Deposit,
    Order,
    OrderEvent,
    RebateRecord,
    RebateSettlement,
    Reconciliation,
)
from app.domain.parties import Counterparty
from app.foundation import service as foundation_service
from app.orders import service as orders_service


def _non_negative(value: Any, *, field: str) -> Decimal:
    try:
        return require_non_negative(value, field=field)
    except ValueError as exc:
        raise Validation(str(exc), details={"field": field, "value": str(value)}) from exc


def _positive(value: Any, *, field: str) -> Decimal:
    try:
        return require_positive(value, field=field)
    except ValueError as exc:
        raise Validation(str(exc), details={"field": field, "value": str(value)}) from exc


def _text(
    value: Any,
    *,
    field: str,
    message: str,
    required: bool = True,
    uppercase: bool = False,
    type_message: str | None = None,
) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        raise Validation(type_message or f"{field} 必须为文本", details={"field": field})
    text = value.strip()
    if required and not text:
        raise Validation(message, details={"field": field})
    return text.upper() if uppercase else text


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
    category: str,
    amount: Any,
    actor: str,
    order_id: int | None = None,
    note: str | None = None,
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
    money = _positive(amount, field="amount")
    if user is not None and not user.can_see_pool(pool_id):
        raise NotFound("资金池不存在", details={"pool_id": pool_id})
    pool = foundation_service.assert_pool_usable(session, pool_id)
    if counterparty_id is not None and session.get(Counterparty, counterparty_id) is None:
        raise NotFound(
            f"合作方 {counterparty_id} 不存在",
            details={"counterparty_id": counterparty_id},
        )
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
) -> list[Deposit]:
    stmt = select(Deposit)
    if pool_id is not None:
        stmt = stmt.where(Deposit.pool_id == pool_id)
    elif pool_ids is not None:
        stmt = stmt.where(Deposit.pool_id.in_(list(pool_ids)))
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
        stmt = stmt.where(Cashflow.pool_id == pool_id)
    elif pool_ids is not None:
        stmt = stmt.where(Cashflow.pool_id.in_(list(pool_ids)))
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
    return rows


# --------------------------------------------------------------------- 日对账
def _get_reconciliation(
    session: Session,
    reconciliation_id: int,
    user: CurrentUser | None = None,
) -> Reconciliation:
    item = session.get(Reconciliation, reconciliation_id)
    if item is None or (user is not None and not user.can_see_pool(item.pool_id)):
        raise NotFound(
            f"对账记录 {reconciliation_id} 不存在",
            details={"reconciliation_id": reconciliation_id},
        )
    return item


def _system_balance_as_of(session: Session, pool_id: int, reconciled_on: date) -> Decimal:
    signed_amount = case(
        (Cashflow.direction == Direction.IN.value, Cashflow.amount),
        else_=-Cashflow.amount,
    )
    value = session.scalar(
        select(func.coalesce(func.sum(signed_amount), 0)).where(
            Cashflow.pool_id == pool_id,
            Cashflow.occurred_on <= reconciled_on,
            Cashflow.status == CashflowStatus.APPROVED.value,
        )
    )
    # 账户余额可能因历史支出而低于零，但资金快照本身仍必须能记录它。
    return to_money(value or 0)


def create_reconciliation(
    session: Session,
    *,
    pool_id: int,
    reconciled_on: date,
    account_label: str,
    statement_balance: Any,
    actor: str,
    unmatched_flow_ids: Iterable[int] | None = None,
    reason: str | None = None,
    note: str | None = None,
    user: CurrentUser | None = None,
) -> Reconciliation:
    if user is not None and not user.can_see_pool(pool_id):
        raise NotFound("资金池不存在", details={"pool_id": pool_id})
    pool = foundation_service.assert_pool_usable(session, pool_id)
    label = _text(
        account_label,
        field="account_label",
        message="对账账户不能为空",
        type_message="对账账户必须为文本",
    )
    statement = _non_negative(statement_balance, field="statement_balance")
    duplicate = session.scalar(
        select(Reconciliation.id).where(
            Reconciliation.pool_id == pool.id,
            Reconciliation.reconciled_on == reconciled_on,
            Reconciliation.account_label == label,
        )
    )
    if duplicate is not None:
        raise Validation("同一资金池、日期和账户只能对账一次")

    try:
        raw_ids = list(unmatched_flow_ids or [])
    except TypeError as exc:
        raise Validation(
            "未达流水 ID 列表格式无效",
            details={"field": "unmatched_flow_ids"},
        ) from exc
    invalid_ids = [
        flow_id
        for flow_id in raw_ids
        if isinstance(flow_id, bool) or not isinstance(flow_id, int) or flow_id <= 0
    ]
    if invalid_ids:
        raise Validation(
            "未达流水 ID 必须为正整数",
            details={"field": "unmatched_flow_ids", "invalid": invalid_ids},
        )
    if len(raw_ids) != len(set(raw_ids)):
        raise Validation("未达流水不能重复", details={"field": "unmatched_flow_ids"})
    if raw_ids:
        flows = list(
            session.scalars(select(Cashflow).where(Cashflow.id.in_(raw_ids))).all()
        )
        by_id = {flow.id: flow for flow in flows}
        missing = [flow_id for flow_id in raw_ids if flow_id not in by_id]
        if missing:
            raise Validation(
                "未达流水不存在",
                details={"field": "unmatched_flow_ids", "missing": missing},
            )
        invalid = [
            flow.id
            for flow in flows
            if flow.pool_id != pool.id or flow.occurred_on > reconciled_on
        ]
        if invalid:
            raise Validation(
                "未达流水必须属于当前资金池且不晚于对账日",
                details={"field": "unmatched_flow_ids", "invalid": invalid},
            )

    system_balance = _system_balance_as_of(session, pool.id, reconciled_on)
    difference = to_money(statement - system_balance)
    text_reason = _text(
        reason,
        field="reason",
        message="存在差异时必须填写差异原因",
        required=difference != 0,
        type_message="存在差异时必须填写差异原因",
    )
    if difference != 0 and not text_reason:
        raise Validation("存在差异时必须填写差异原因", details={"field": "reason"})
    item = Reconciliation(
        pool_id=pool.id,
        reconciled_on=reconciled_on,
        account_label=label,
        system_balance=system_balance,
        statement_balance=statement,
        difference=difference,
        status=ReconciliationStatus.OPEN.value,
        reason=text_reason or None,
        unmatched_flow_ids=raw_ids,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(item)
    session.flush()
    record_audit(
        session,
        action=AuditAction.RECONCILIATION_CREATE,
        entity_type="reconciliation",
        entity_id=str(item.id),
        actor=actor,
        after={
            "pool_id": pool.id,
            "reconciled_on": reconciled_on.isoformat(),
            "system_balance": str(system_balance),
            "statement_balance": str(statement),
            "difference": str(difference),
            "unmatched_flow_ids": raw_ids,
        },
        reason=text_reason or None,
    )
    return item


def list_reconciliations(
    session: Session,
    *,
    pool_id: int | None = None,
    pool_ids: Iterable[int] | None = None,
    user: CurrentUser | None = None,
) -> list[Reconciliation]:
    stmt = select(Reconciliation)
    if pool_id is not None:
        if user is not None and not user.can_see_pool(pool_id):
            return []
        stmt = stmt.where(Reconciliation.pool_id == pool_id)
    elif pool_ids is not None:
        visible_pool_ids = list(pool_ids)
        if user is not None and not (user.is_admin or user.owner_scope == "ALL"):
            visible_pool_ids = [pool for pool in visible_pool_ids if user.can_see_pool(pool)]
        stmt = stmt.where(Reconciliation.pool_id.in_(visible_pool_ids))
    elif user is not None and not (user.is_admin or user.owner_scope == "ALL"):
        stmt = stmt.where(Reconciliation.pool_id.in_(sorted(user.pool_ids)))
    return list(
        session.scalars(
            stmt.order_by(
                Reconciliation.reconciled_on.desc(), Reconciliation.id.desc()
            )
        ).all()
    )


def resolve_reconciliation(
    session: Session,
    reconciliation_id: int,
    *,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
) -> Reconciliation:
    text_reason = _text(
        reason,
        field="reason",
        message="核销对账必须填写处理说明",
        type_message="核销对账必须填写处理说明",
    )
    item = _get_reconciliation(session, reconciliation_id, user)
    if item.status != ReconciliationStatus.OPEN.value:
        raise Validation("该对账记录已核销", details={"reconciliation_id": item.id})
    item.status = ReconciliationStatus.RESOLVED.value
    item.resolved_by = actor
    item.resolved_at = datetime.now()
    item.reason = f"{item.reason}; {text_reason}" if item.reason else text_reason
    item.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.RECONCILIATION_RESOLVE,
        entity_type="reconciliation",
        entity_id=str(item.id),
        actor=actor,
        after={"status": item.status, "resolved_by": actor},
        reason=text_reason,
    )
    return item


def create_transfer(
    session: Session,
    *,
    source_pool_id: int,
    target_pool_id: int,
    amount: Any,
    occurred_on: date,
    actor: str,
    note: str | None = None,
) -> dict[str, Any]:
    """原子生成一出一入的 INTERNAL 流水，完成池间转移且不改变合并现金。"""
    if source_pool_id == target_pool_id:
        raise Validation("转出池与转入池不能相同", details={"pool_id": source_pool_id})
    money = _positive(amount, field="amount")
    source = foundation_service.assert_pool_usable(session, source_pool_id)
    target = foundation_service.assert_pool_usable(session, target_pool_id)
    # Cashflow.flow_no 长度为 32；保留可读前缀并控制两条流水编号不超列长度。
    transfer_id = f"TRF-{uuid4().hex[:20].upper()}"
    common = {
        "transfer_id": transfer_id,
        "occurred_on": occurred_on,
        "nature": Nature.INTERNAL.value,
        "category": "TRANSFER",
        "amount": money,
        "created_by": actor,
        "updated_by": actor,
    }
    outgoing = Cashflow(
        flow_no=f"{transfer_id}-OUT",
        pool_id=source.id,
        direction=Direction.OUT.value,
        note=note,
        **common,
    )
    incoming = Cashflow(
        flow_no=f"{transfer_id}-IN",
        pool_id=target.id,
        direction=Direction.IN.value,
        note=note,
        **common,
    )
    session.add_all([outgoing, incoming])
    session.flush()
    record_audit(
        session,
        action=AuditAction.TRANSFER_CREATE,
        entity_type="transfer",
        entity_id=transfer_id,
        actor=actor,
        after={
            "source_pool": source.code,
            "target_pool": target.code,
            "amount": str(money),
        },
    )
    return {
        "transfer_id": transfer_id,
        "source_pool_id": source.id,
        "target_pool_id": target.id,
        "amount": money,
        "occurred_on": occurred_on,
        "cashflows": [outgoing, incoming],
    }


def repair_transfer(
    session: Session,
    transfer_id: str,
    *,
    counterpart_pool_id: int,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """只为单边内部划转补齐缺失的一边，禁止把异常静默当成正常新划转。"""
    text_reason = _text(
        reason,
        field="reason",
        message="划转修复必须填写原因",
        type_message="划转修复必须填写原因",
    )
    transfer = _text(
        transfer_id,
        field="transfer_id",
        message="transfer_id 不能为空",
        type_message="transfer_id 必须为文本",
    )
    rows = list(
        session.scalars(
            select(Cashflow)
            .where(
                Cashflow.transfer_id == transfer,
                Cashflow.nature == Nature.INTERNAL.value,
            )
            .order_by(Cashflow.id)
        ).all()
    )
    if not rows:
        raise NotFound(f"划转 {transfer} 不存在", details={"transfer_id": transfer})
    if len(rows) == 2:
        raise Validation("该划转已完整，不能重复修复", details={"transfer_id": transfer})
    if len(rows) != 1:
        raise Validation("该划转不是单边记录，不能自动修复", details={"transfer_id": transfer})
    source = rows[0]
    if user is not None and (
        not user.can_see_pool(source.pool_id) or not user.can_see_pool(counterpart_pool_id)
    ):
        raise NotFound("资金池不存在", details={"pool_id": counterpart_pool_id})
    target = foundation_service.assert_pool_usable(session, counterpart_pool_id)
    if target.id == source.pool_id:
        raise Validation("修复对端资金池不能与原资金池相同")
    if source.direction == Direction.OUT.value:
        direction = Direction.IN.value
    elif source.direction == Direction.IN.value:
        direction = Direction.OUT.value
    else:
        raise Validation("单边划转方向无效", details={"transfer_id": transfer})
    flow = Cashflow(
        flow_no=allocate_number(session, SequenceKey.CASHFLOW.value),
        pool_id=target.id,
        occurred_on=source.occurred_on,
        nature=Nature.INTERNAL.value,
        category="TRANSFER",
        direction=direction,
        amount=to_money(source.amount),
        transfer_id=transfer,
        status=source.status,
        reviewed_by=source.reviewed_by,
        reviewed_at=source.reviewed_at,
        note=f"修复划转 {transfer}: {text_reason}",
        created_by=actor,
        updated_by=actor,
    )
    session.add(flow)
    session.flush()
    record_audit(
        session,
        action=AuditAction.TRANSFER_REPAIR,
        entity_type="transfer",
        entity_id=transfer,
        actor=actor,
        after={
            "source_flow_id": source.id,
            "repaired_flow_id": flow.id,
            "counterpart_pool_id": target.id,
            "amount": str(flow.amount),
        },
        reason=text_reason,
    )
    return {
        "transfer_id": transfer,
        "source_pool_id": source.pool_id if source.direction == Direction.OUT.value else target.id,
        "target_pool_id": target.id if source.direction == Direction.OUT.value else source.pool_id,
        "amount": to_money(source.amount),
        "occurred_on": source.occurred_on,
        "cashflows": [source, flow],
    }


def deposit_held_total(session: Session, pool_id: int | None = None) -> Decimal:
    stmt = select(
        func.coalesce(
            func.sum(Deposit.paid_amount - Deposit.returned_amount - Deposit.lost_amount),
            0,
        )
    )
    if pool_id:
        stmt = stmt.where(Deposit.pool_id == pool_id)
    return to_money(session.scalar(stmt) or 0)


# --------------------------------------------------------------------- 返点
def create_rebate(
    session: Session,
    *,
    source_order_id: int,
    base_amount: Any,
    collected_on: date,
    actor: str,
    rebate_type: str | None = None,
    rate: Any = 0,
    channel: str | None = None,
    note: str | None = None,
    user: CurrentUser | None = None,
) -> RebateRecord:
    """返点记录：来源订单必填且必须已成单（REB-01-02）。"""
    try:
        order = orders_service.get_order(session, source_order_id, user)
    except NotFound as exc:
        if user is not None:
            raise
        raise Validation(
            f"来源订单 {source_order_id} 不存在",
            code=ErrorCode.RESOURCE_NOT_FOUND,
            details={"source_order_id": source_order_id},
        ) from exc
    if order.status not in (OrderStatus.ACTIVE.value, OrderStatus.COMPLETED.value):
        raise Validation(
            f"来源订单 {order.order_no} 状态 {order.status}，不可作为返点来源",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"order_no": order.order_no, "status": order.status},
        )
    if rebate_type not in RebateType.values():
        raise Validation(
            f"返点类型必须为 {RebateType.values()}",
            details={"field": "rebate_type", "value": rebate_type},
        )
    if rebate_type == RebateType.BUY.value and order.order_type != "HS":
        raise Validation(
            "买号返点只能关联回收（HS）订单",
            details={"rebate_type": rebate_type, "order_type": order.order_type},
        )
    required_event = {
        RebateType.BUY.value: EventType.BUY.value,
        RebateType.SELL.value: EventType.SELL.value,
    }[rebate_type]
    if session.scalar(
        select(OrderEvent.id).where(
            OrderEvent.order_id == order.id,
            OrderEvent.event_type == required_event,
            OrderEvent.is_posted.is_(True),
        )
    ) is None:
        label = "买号返点" if rebate_type == RebateType.BUY.value else "卖号返点"
        raise Validation(
            f"{label}必须关联已过账的 {required_event} 事件",
            details={
                "rebate_type": rebate_type,
                "order_id": order.id,
                "required_event": required_event,
            },
        )

    base = _positive(base_amount, field="base_amount")
    rebate_rate = _non_negative(rate, field="rate")
    if rebate_rate > Decimal("100.00"):
        raise Validation(
            "返点比例必须在 0% 到 100% 之间",
            details={"field": "rate", "value": str(rebate_rate)},
        )

    rebate_no = order_rebate_no(session, order_no=order.order_no, order_id=order.id)
    # BAS-06-04：按返点日期固化规则版本，改版不影响历史记录
    order_type_definition = foundation_service.get_order_type_by_code(
        session, order.order_type
    )
    policy_version_id, snapshot = policy_service.make_snapshot(
        session,
        policy_code=PolicyType.REBATE.value,
        on=collected_on,
        scope_type="ORDER_TYPE",
        scope_id=order_type_definition.id if order_type_definition else None,
    )
    record = RebateRecord(
        rebate_no=rebate_no,
        source_order_id=order.id,
        rebate_type=rebate_type,
        channel=channel,
        rate=rebate_rate,
        base_amount=base,
        collected_on=collected_on,
        policy_version_id=policy_version_id,
        policy_snapshot=snapshot,
        status=RebateStatus.OPEN.value,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(record)
    session.flush()
    record_audit(
        session,
        action=AuditAction.REBATE_CREATE,
        entity_type="rebate_record",
        entity_id=record.rebate_no,
        actor=actor,
        after={"source_order": order.order_no, "base_amount": str(base)},
    )
    return record


def settle_rebate(
    session: Session,
    rebate_record_id: int,
    *,
    gross_amount: Any,
    settled_on: date,
    pool_id: int,
    actor: str,
    platform_fee: Any = 0,
    note: str | None = None,
    user: CurrentUser | None = None,
) -> RebateSettlement:
    record = session.get(RebateRecord, rebate_record_id)
    if record is None:
        raise NotFound(
            f"返点记录 {rebate_record_id} 不存在", details={"rebate_record_id": rebate_record_id}
        )
    try:
        orders_service.get_order(session, record.source_order_id, user)
    except NotFound as exc:
        raise NotFound(
            f"返点记录 {rebate_record_id} 不存在",
            details={"rebate_record_id": rebate_record_id},
        ) from exc
    if user is not None and not user.can_see_pool(pool_id):
        raise NotFound("资金池不存在", details={"pool_id": pool_id})
    gross = _positive(gross_amount, field="gross_amount")
    fee = _non_negative(platform_fee, field="platform_fee")
    if fee > gross:
        raise Validation(
            "手续费不得大于到账金额", details={"gross": str(gross), "fee": str(fee)}
        )
    net = gross - fee

    # 可结算上限 = 返点基数 base_amount；反向记录按负数抵减累计毛额。
    receivable = to_money(record.base_amount)
    already_gross, _, _ = _effective_rebate_totals(session, record.id)
    if already_gross + gross > receivable:
        raise Validation(
            "累计结算金额超过可结算上限",
            code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE,
            details={
                "rebate_no": record.rebate_no,
                "receivable": str(receivable),
                "settled": str(already_gross),
                "this_time": str(gross),
            },
        )
    pool = foundation_service.assert_pool_usable(session, pool_id)

    settlement_no = rebate_settlement_no(
        session, rebate_no=record.rebate_no, rebate_record_id=record.id
    )

    flow = Cashflow(
        flow_no=settlement_no,
        pool_id=pool.id,
        occurred_on=settled_on,
        nature=Nature.BUSINESS_IN.value,
        category="REBATE",
        direction=Direction.IN.value,
        amount=net,
        order_id=record.source_order_id,
        note=f"返点结算 {settlement_no}",
        created_by=actor,
        updated_by=actor,
    )
    session.add(flow)
    session.flush()

    settlement = RebateSettlement(
        settlement_no=settlement_no,
        rebate_record_id=record.id,
        settled_on=settled_on,
        gross_amount=gross,
        platform_fee=fee,
        net_amount=net,
        cashflow_id=flow.id,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(settlement)

    session.flush()
    _refresh_rebate_status(session, record)
    record_audit(
        session,
        action=AuditAction.REBATE_SETTLE,
        entity_type="rebate_settlement",
        entity_id=settlement_no,
        actor=actor,
        after={"gross": str(gross), "fee": str(fee), "net": str(net)},
    )
    return settlement


def _effective_rebate_totals(
    session: Session, rebate_record_id: int
) -> tuple[Decimal, Decimal, Decimal]:
    """返回有效毛额、手续费和净额；反向结算按负数计算。"""
    gross = Decimal("0")
    fee = Decimal("0")
    net = Decimal("0")
    rows = session.scalars(
        select(RebateSettlement).where(
            RebateSettlement.rebate_record_id == rebate_record_id
        )
    ).all()
    for row in rows:
        sign = Decimal("-1") if row.reversal_of_id is not None else Decimal("1")
        gross += sign * to_money(row.gross_amount)
        fee += sign * to_money(row.platform_fee)
        net += sign * to_money(row.net_amount)
    return gross, fee, net


def _refresh_rebate_status(session: Session, record: RebateRecord) -> None:
    settled_gross, _, _ = _effective_rebate_totals(session, record.id)
    receivable = to_money(record.base_amount)
    if settled_gross <= 0:
        record.status = RebateStatus.OPEN.value
    elif settled_gross >= receivable:
        record.status = RebateStatus.SETTLED.value
    else:
        record.status = RebateStatus.PARTIALLY_SETTLED.value


def list_rebate_settlements(
    session: Session,
    rebate_record_id: int,
    *,
    user: CurrentUser | None = None,
) -> list[RebateSettlement]:
    record = session.get(RebateRecord, rebate_record_id)
    if record is None:
        raise NotFound(
            f"返点记录 {rebate_record_id} 不存在",
            details={"rebate_record_id": rebate_record_id},
        )
    if record.source_order_id is None:
        if user is not None and not (user.is_admin or user.owner_scope == "ALL"):
            raise NotFound(
                f"返点记录 {rebate_record_id} 不存在",
                details={"rebate_record_id": rebate_record_id},
            )
    else:
        orders_service.get_order(session, record.source_order_id, user)
    return list(
        session.scalars(
            select(RebateSettlement)
            .where(RebateSettlement.rebate_record_id == record.id)
            .order_by(RebateSettlement.id)
        ).all()
    )


def reverse_rebate_settlement(
    session: Session,
    rebate_record_id: int,
    settlement_id: int,
    *,
    reversed_on: date,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
) -> RebateSettlement:
    """以反向结算和反向流水更正一笔已发生的返点到账。"""
    text_reason = _text(
        reason,
        field="reason",
        message="返点冲销必须填写原因",
        type_message="返点冲销必须填写原因",
    )
    record = session.get(RebateRecord, rebate_record_id)
    if record is None or record.source_order_id is None:
        raise NotFound(
            f"返点记录 {rebate_record_id} 不存在",
            details={"rebate_record_id": rebate_record_id},
        )
    orders_service.get_order(session, record.source_order_id, user)
    original = session.scalar(
        select(RebateSettlement).where(
            RebateSettlement.id == settlement_id,
            RebateSettlement.rebate_record_id == record.id,
        )
    )
    if original is None:
        raise NotFound(
            f"返点结算 {settlement_id} 不存在",
            details={"settlement_id": settlement_id},
        )
    if original.reversal_of_id is not None:
        raise Validation("冲销记录不能再次冲销")
    if session.scalar(
        select(RebateSettlement.id).where(
            RebateSettlement.reversal_of_id == original.id
        )
    ) is not None:
        raise Validation("该返点结算已冲销", details={"settlement_id": settlement_id})
    if original.cashflow_id is None:
        raise Validation("返点结算缺少资金流水，无法冲销")
    original_flow = session.get(Cashflow, original.cashflow_id)
    if original_flow is None:
        raise Validation("返点结算关联的资金流水不存在")
    if user is not None and not user.can_see_pool(original_flow.pool_id):
        raise NotFound("资金池不存在", details={"pool_id": original_flow.pool_id})

    settlement_no = rebate_settlement_no(
        session, rebate_no=record.rebate_no, rebate_record_id=record.id
    )
    reversal_flow = Cashflow(
        flow_no=settlement_no,
        pool_id=original_flow.pool_id,
        occurred_on=reversed_on,
        nature=Nature.BUSINESS_OUT.value,
        category="REBATE_REVERSAL",
        direction=Direction.OUT.value,
        amount=to_money(original.net_amount),
        order_id=record.source_order_id,
        reversal_of_id=original_flow.id,
        status=CashflowStatus.APPROVED.value,
        reviewed_by=actor,
        reviewed_at=datetime.now(),
        reversal_reason=text_reason,
        note=f"返点冲销 {original.settlement_no}",
        created_by=actor,
        updated_by=actor,
    )
    session.add(reversal_flow)
    session.flush()

    reversal = RebateSettlement(
        settlement_no=settlement_no,
        rebate_record_id=record.id,
        settled_on=reversed_on,
        gross_amount=to_money(original.gross_amount),
        platform_fee=to_money(original.platform_fee),
        net_amount=to_money(original.net_amount),
        cashflow_id=reversal_flow.id,
        reversal_of_id=original.id,
        note=text_reason,
        created_by=actor,
        updated_by=actor,
    )
    session.add(reversal)
    session.flush()
    _refresh_rebate_status(session, record)
    record_audit(
        session,
        action=AuditAction.REBATE_REVERSE,
        entity_type="rebate_settlement",
        entity_id=settlement_no,
        actor=actor,
        after={
            "reversal_of": original.settlement_no,
            "gross": str(reversal.gross_amount),
            "fee": str(reversal.platform_fee),
            "net": str(reversal.net_amount),
            "status": record.status,
        },
        reason=text_reason,
    )
    return reversal


def list_rebates(
    session: Session,
    *,
    source_order_id: int | None = None,
    user: CurrentUser | None = None,
) -> list[RebateRecord]:
    from app.domain.trade import Order

    stmt = select(RebateRecord)
    if source_order_id is not None:
        stmt = stmt.where(RebateRecord.source_order_id == source_order_id)
    scope = owner_scope_filter(Order.owner_id, user, session) if user is not None else None
    if scope is not None:
        stmt = stmt.join(Order, Order.id == RebateRecord.source_order_id).where(scope)
    return list(session.scalars(stmt.order_by(RebateRecord.id)).all())


def settled_net_total(session: Session, rebate_record_id: int) -> Decimal:
    _, _, net = _effective_rebate_totals(session, rebate_record_id)
    return net


__all__ = [
    "approve_cashflow",
    "create_cashflow",
    "create_deposit",
    "create_rebate",
    "deposit_held_total",
    "list_cashflows",
    "create_reconciliation",
    "list_reconciliations",
    "resolve_reconciliation",
    "list_deposits",
    "list_rebates",
    "create_transfer",
    "repair_transfer",
    "return_deposit",
    "lose_deposit",
    "reject_cashflow",
    "reverse_cashflow",
    "settle_rebate",
    "list_rebate_settlements",
    "reverse_rebate_settlement",
    "settled_net_total",
]
