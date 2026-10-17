"""finance 返点服务（REB-01）。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.business_numbering import rebate_no as order_rebate_no
from app.core.business_numbering import rebate_settlement_no
from app.core.errors import ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.core.periods import assert_period_open
from app.core.security import CurrentUser, owner_scope_filter
from app.domain.enums import (
    AuditAction,
    CashflowStatus,
    Direction,
    EventType,
    Nature,
    OrderStatus,
    PolicyType,
    RebateStatus,
    RebateType,
)
from app.domain.trade import Cashflow, Order, OrderEvent, RebateRecord, RebateSettlement
from app.foundation import service as foundation_service
from app.notifications import service as notifications_service
from app.orders import service as orders_service
from app.policy import service as policy_service

from ._common import _non_negative, _positive, _text

# --------------------------------------------------------------------- 返点
def create_rebate(
    session: Session,
    *,
    source_order_id: int,
    base_amount: Any,
    collected_on: date,
    actor: str,
    expected_on: date | None = None,
    rebate_type: str | None = None,
    rate: Any = None,
    channel: str | None = None,
    note: str | None = None,
    user: CurrentUser | None = None,
) -> RebateRecord:
    """返点记录：来源订单必填且必须已成单（REB-01-02）。"""
    assert_period_open(session, collected_on, operation="创建返点记录")
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
    if rebate_type == RebateType.SELL.value and order.order_type != "DG":
        raise Validation(
            "卖号返点只能关联分销（DG）订单",
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
    if rate is None:
        rate = _rebate_rate_from_snapshot(snapshot, rebate_type)
    rebate_rate = _non_negative(Decimal("0") if rate is None else rate, field="rate")
    if rebate_rate > Decimal("100.00"):
        raise Validation(
            "返点比例必须在 0% 到 100% 之间",
            details={"field": "rate", "value": str(rebate_rate)},
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
        expected_on=expected_on,
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


def _rebate_rate_from_snapshot(
    snapshot: dict[str, Any] | None, rebate_type: str
) -> Decimal | None:
    """从 REBATE 规则快照读取费率；显式传入的 rate 始终优先。"""
    if not snapshot:
        return None
    config = snapshot.get("config")
    if not isinstance(config, dict):
        return None
    rates = config.get("rates")
    value: Any = rates.get(rebate_type) if isinstance(rates, dict) else None
    if value is None:
        value = config.get("rate")
    if value is None:
        return None
    try:
        return to_money(value)
    except (TypeError, ValueError, ArithmeticError) as exc:
        raise Validation(
            "返点规则中的费率必须是数值",
            details={"field": "config.rate", "value": value},
        ) from exc


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
    assert_period_open(session, settled_on, operation="登记返点到账")
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
    record.updated_by = actor
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
    assert_period_open(session, reversed_on, operation="创建返点冲销")
    record = session.get(RebateRecord, rebate_record_id)
    if record is None:
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
    record.updated_by = actor
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


def list_overdue_rebates(
    session: Session,
    *,
    as_of: date,
    user: CurrentUser | None = None,
) -> list[tuple[RebateRecord, int]]:
    """列出预计到账日已过且仍未结清的返点，返回逾期天数。"""
    stmt = (
        select(RebateRecord)
        .join(Order, Order.id == RebateRecord.source_order_id)
        .where(
            RebateRecord.expected_on.is_not(None),
            RebateRecord.expected_on < as_of,
            RebateRecord.status != RebateStatus.SETTLED.value,
        )
    )
    scope = owner_scope_filter(Order.owner_id, user, session) if user is not None else None
    if scope is not None:
        stmt = stmt.where(scope)
    rows = session.scalars(
        stmt.order_by(RebateRecord.expected_on, RebateRecord.id)
    ).all()
    return [(row, (as_of - row.expected_on).days) for row in rows if row.expected_on is not None]


def sync_overdue_rebate_notifications(
    session: Session,
    *,
    as_of: date,
    actor: str,
) -> dict[str, int | str]:
    """为逾期返点的订单负责人生成幂等跟进通知。"""
    created = 0
    existing = 0
    skipped = 0
    for rebate, overdue_days in list_overdue_rebates(session, as_of=as_of):
        order = session.get(Order, rebate.source_order_id)
        if order is None or order.owner_id is None:
            skipped += 1
            continue
        _, is_created = notifications_service.ensure_notification(
            session,
            recipient_user_id=order.owner_id,
            notification_type="REBATE_OVERDUE",
            title="返点到账逾期",
            message=(
                f"{rebate.rebate_no}：预计 {rebate.expected_on.isoformat()} 到账，"
                f"已逾期 {overdue_days} 天。"
            ),
            entity_type="rebate_record",
            entity_id=rebate.rebate_no,
            actor=actor,
        )
        if is_created:
            created += 1
        else:
            existing += 1
    return {
        "as_of": as_of.isoformat(),
        "created": created,
        "existing": existing,
        "skipped": skipped,
    }


def get_rebate(
    session: Session,
    rebate_id: int,
    *,
    user: CurrentUser | None = None,
) -> RebateRecord:
    record = session.get(RebateRecord, rebate_id)
    if record is None:
        raise NotFound("返点记录不存在", details={"rebate_record_id": rebate_id})
    if user is not None:
        from app.domain.trade import Order

        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            visible = session.scalar(
                select(RebateRecord.id)
                .join(Order, Order.id == RebateRecord.source_order_id)
                .where(RebateRecord.id == rebate_id, scope)
            )
            if visible is None:
                raise NotFound("返点记录不存在", details={"rebate_record_id": rebate_id})
    return record


def settled_net_total(session: Session, rebate_record_id: int) -> Decimal:
    _, _, net = _effective_rebate_totals(session, rebate_record_id)
    return net

__all__ = [
    "create_rebate",
    "get_rebate",
    "list_overdue_rebates",
    "list_rebate_settlements",
    "list_rebates",
    "reverse_rebate_settlement",
    "settle_rebate",
    "settled_net_total",
    "sync_overdue_rebate_notifications",
]

