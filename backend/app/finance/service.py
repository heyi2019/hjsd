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

from sqlalchemy import func, select
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
    Nature,
    OrderStatus,
    PolicyType,
    RebateStatus,
    SequenceKey,
)
from app.domain.trade import Cashflow, Deposit, Order, RebateRecord, RebateSettlement
from app.foundation import service as foundation_service
from app.orders import service as orders_service


def _non_negative(value: Any, *, field: str) -> Decimal:
    try:
        return require_non_negative(value, field=field)
    except ValueError as exc:
        raise Validation(str(exc), details={"field": field, "value": str(value)}) from exc


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
    label = (category or "").strip().upper()
    if not label:
        raise Validation("category 不能为空", details={"field": "category"})
    if nature == Nature.EXTERNAL_IN.value and not (note or "").strip():
        raise Validation("独立收款必须填写摘要", details={"field": "note"})
    if user is not None and not user.can_see_pool(pool_id):
        raise NotFound("资金池不存在", details={"pool_id": pool_id})
    pool = foundation_service.assert_pool_usable(session, pool_id)
    if order_id is not None:
        orders_service.get_order(session, order_id, user)
    money = require_positive(amount, field="amount")
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
    text_reason = (reason or "").strip()
    if not text_reason:
        raise Validation("驳回流水必须填写原因", details={"field": "reason"})
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
    text_reason = (reason or "").strip()
    if not text_reason:
        raise Validation("冲销流水必须填写原因", details={"field": "reason"})
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
    money = require_positive(amount, field="amount")
    if user is not None and not user.can_see_pool(pool_id):
        raise NotFound("资金池不存在", details={"pool_id": pool_id})
    pool = foundation_service.assert_pool_usable(session, pool_id)
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
    money = require_positive(amount, field="amount")
    outstanding = to_money(deposit.paid_amount) - to_money(deposit.returned_amount)
    if money > outstanding:
        raise Validation(
            "退还金额超过未释放余额",
            code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE,
            details={"deposit_id": deposit.id, "outstanding": str(outstanding)},
        )

    deposit.returned_amount = to_money(deposit.returned_amount) + money
    deposit.released_on = released_on
    deposit.status = (
        DepositStatus.RETURNED.value
        if deposit.returned_amount >= deposit.paid_amount
        else DepositStatus.PARTIALLY_RETURNED.value
    )
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
        elif flow.category == "REBATE":
            source = "REBATE_SETTLEMENT"
        elif flow.category in {"DEPOSIT_HOLD", "DEPOSIT_RELEASE"}:
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
            }
        )
    return rows


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
    money = require_positive(amount, field="amount")
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


def deposit_held_total(session: Session, pool_id: int | None = None) -> Decimal:
    stmt = select(func.coalesce(func.sum(Deposit.paid_amount - Deposit.returned_amount), 0))
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

    base = require_positive(base_amount, field="base_amount")
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
    gross = require_positive(gross_amount, field="gross_amount")
    fee = _non_negative(platform_fee, field="platform_fee")
    if fee > gross:
        raise Validation(
            "手续费不得大于到账金额", details={"gross": str(gross), "fee": str(fee)}
        )
    net = gross - fee

    # 可结算上限 = 返点基数 base_amount；累计毛额（含本次）不得突破（REB-01 分次结算）
    receivable = to_money(record.base_amount)
    already_gross = to_money(
        session.scalar(
            select(func.coalesce(func.sum(RebateSettlement.gross_amount), 0)).where(
                RebateSettlement.rebate_record_id == record.id
            )
        )
        or 0
    )
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

    settled_gross_total = to_money(
        session.scalar(
            select(func.coalesce(func.sum(RebateSettlement.gross_amount), 0)).where(
                RebateSettlement.rebate_record_id == record.id
            )
        )
        or 0
    ) + gross
    record.status = (
        RebateStatus.SETTLED.value
        if settled_gross_total >= receivable
        else RebateStatus.PARTIALLY_SETTLED.value
    )
    session.flush()
    record_audit(
        session,
        action=AuditAction.REBATE_SETTLE,
        entity_type="rebate_settlement",
        entity_id=settlement_no,
        actor=actor,
        after={"gross": str(gross), "fee": str(fee), "net": str(net)},
    )
    return settlement


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
    return to_money(
        session.scalar(
            select(func.coalesce(func.sum(RebateSettlement.net_amount), 0)).where(
                RebateSettlement.rebate_record_id == rebate_record_id
            )
        )
        or 0
    )


__all__ = [
    "approve_cashflow",
    "create_cashflow",
    "create_deposit",
    "create_rebate",
    "deposit_held_total",
    "list_cashflows",
    "list_deposits",
    "list_rebates",
    "create_transfer",
    "return_deposit",
    "reject_cashflow",
    "reverse_cashflow",
    "settle_rebate",
    "settled_net_total",
]
