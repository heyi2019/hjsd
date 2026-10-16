"""finance.service：押金与返点（FIN-04 / REB-01）。

- 押金不进损益，只改变可用余额；缴退都必须有现金流（A08）；
- 返点记录必须关联来源订单，分次到账使用订单从属号，净额 = 毛额 − 手续费（A06）。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.business_numbering import rebate_no as order_rebate_no
from app.core.business_numbering import rebate_settlement_no
from app.core.errors import NotFound, Validation
from app.core.errors import ErrorCode
from app.core.money import require_positive, to_money
from app.core.numbering import allocate_number
from app.policy import service as policy_service
from app.domain.enums import (
    AuditAction,
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
) -> Deposit:
    money = require_positive(amount, field="amount")
    pool = foundation_service.assert_pool_usable(session, pool_id)

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
    session: Session, deposit_id: int, *, amount: Any, released_on: date, actor: str
) -> Deposit:
    deposit = session.get(Deposit, deposit_id)
    if deposit is None:
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


def list_deposits(session: Session, *, pool_id: int | None = None) -> list[Deposit]:
    stmt = select(Deposit)
    if pool_id:
        stmt = stmt.where(Deposit.pool_id == pool_id)
    return list(session.scalars(stmt.order_by(Deposit.id)).all())


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
) -> RebateRecord:
    """返点记录：来源订单必填且必须已成单（REB-01-02）。"""
    order = session.get(Order, source_order_id)
    if order is None:
        raise Validation(
            f"来源订单 {source_order_id} 不存在",
            code=ErrorCode.RESOURCE_NOT_FOUND,
            details={"source_order_id": source_order_id},
        )
    if order.status not in (OrderStatus.ACTIVE.value, OrderStatus.COMPLETED.value):
        raise Validation(
            f"来源订单 {order.order_no} 状态 {order.status}，不可作为返点来源",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"order_no": order.order_no, "status": order.status},
        )

    rebate_no = order_rebate_no(session, order_no=order.order_no, order_id=order.id)
    # BAS-06-04：按返点日期固化规则版本，改版不影响历史记录
    policy_version_id, snapshot = policy_service.make_snapshot(
        session, policy_code=PolicyType.REBATE.value, on=collected_on
    )
    record = RebateRecord(
        rebate_no=rebate_no,
        source_order_id=order.id,
        channel=channel,
        rate=to_money(rate),
        base_amount=to_money(base_amount),
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
        after={"source_order": order.order_no, "base_amount": str(to_money(base_amount))},
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
) -> RebateSettlement:
    record = session.get(RebateRecord, rebate_record_id)
    if record is None:
        raise NotFound(
            f"返点记录 {rebate_record_id} 不存在", details={"rebate_record_id": rebate_record_id}
        )
    gross = require_positive(gross_amount, field="gross_amount")
    fee = to_money(platform_fee)
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

    settled_total = to_money(
        session.scalar(
            select(func.coalesce(func.sum(RebateSettlement.net_amount), 0)).where(
                RebateSettlement.rebate_record_id == record.id
            )
        )
        or 0
    ) + net
    record.status = (
        RebateStatus.SETTLED.value
        if settled_total >= receivable
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


def list_rebates(session: Session, *, source_order_id: int | None = None) -> list[RebateRecord]:
    stmt = select(RebateRecord)
    if source_order_id:
        stmt = stmt.where(RebateRecord.source_order_id == source_order_id)
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
    "create_deposit",
    "create_rebate",
    "deposit_held_total",
    "list_deposits",
    "list_rebates",
    "return_deposit",
    "settle_rebate",
    "settled_net_total",
]
