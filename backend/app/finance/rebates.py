"""finance 返点服务（REB-01）。"""
from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.business_numbering import rebate_no as order_rebate_no
from app.core.errors import ErrorCode, NotFound, Validation
from app.core.security import CurrentUser, owner_scope_filter
from app.domain.enums import (
    AuditAction,
    CashflowSourceType,
    Direction,
    Nature,
    OrderStatus,
    RebateStatus,
    RebateType,
)
from app.domain.trade import Cashflow, OrderEvent, RebateRecord
from app.domain.users import User
from app.foundation.pools import require_default_pool
from app.orders._shared import get_order
from app.orders.events import post_event
from app.orders.form_fields import validate_form_extra
from ._common import _positive

# --------------------------------------------------------------------- 返点
def create_rebate(
    session: Session,
    *,
    source_order_id: int,
    amount: Any,
    collected_on: date,
    actor: str,
    rebate_type: str | None = None,
    channel: str | None = None,
    note: str | None = None,
    operator_user_ids: list[int] | None = None,
    form_extra: dict[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> RebateRecord:
    """返点记录：来源订单必填且必须已成单（REB-01-02）。

    返点金额由登记人明确提供。
    """
    try:
        order = get_order(session, source_order_id, user)
    except NotFound as exc:
        if user is not None:
            raise
        raise Validation(
            f"来源订单 {source_order_id} 不存在",
            code=ErrorCode.RESOURCE_NOT_FOUND,
            details={"source_order_id": source_order_id},
        ) from exc
    if order.status not in (
        OrderStatus.ACTIVE.value,
        OrderStatus.INSTALLMENT.value,
        OrderStatus.COMPLETED.value,
    ):
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
    if rebate_type == RebateType.BUY.value and order.order_type not in ("HS", "TH"):
        raise Validation(
            "买号返点只能关联回收、提号订单",
            details={"rebate_type": rebate_type, "order_type": order.order_type},
        )
    # 返点资格由业务订单是否已创建决定；BUY/SELL 仅作为后续业务事实，
    # 不能阻止在订单创建后先登记预计返点。

    rebate_no = order_rebate_no(session, order_no=order.order_no, order_id=order.id)
    amount = _positive(amount, field="amount")
    operator_ids = _validate_operator_user_ids(session, operator_user_ids)
    record = RebateRecord(
        rebate_no=rebate_no,
        source_order_id=order.id,
        rebate_type=rebate_type,
        channel=channel,
        amount=amount,
        collected_on=collected_on,
        # 返点登记即完成收入确认，不再走后续结算/冲销状态机。
        status=RebateStatus.SETTLED.value,
        note=note,
        operator_user_ids=operator_ids,
        form_extra=validate_form_extra(session, order_type_code="INVREBATE", values=form_extra) or None,
        created_by=actor,
        updated_by=actor,
    )
    session.add(record)
    session.flush()
    # 返点是业务动作，同时形成一笔收入资金明细；两者共享订单与发生日，
    # 资金明细通过统一来源引用回指动作，避免返点只停留在附属表里。
    event, _ = post_event(
        session,
        order.id,
        event_type="REBATE",
        amount=amount,
        occurred_on=collected_on,
        actor=actor,
        rebate_type=rebate_type,
        note=note,
        operator_user_ids=operator_ids,
        form_extra_scope="INVREBATE",
        form_extra=form_extra,
        user=user,
    )
    event_extra = dict(event.form_extra or {})
    event_extra["rebate_record_id"] = record.id
    event.form_extra = event_extra
    pool = require_default_pool(session)
    from app.finance.cashflows import create_cashflow

    flow = create_cashflow(
        session,
        pool_id=pool.id,
        occurred_on=collected_on,
        direction=Direction.IN.value,
        nature=Nature.BUSINESS_IN.value,
        category="REBATE",
        amount=amount,
        actor=actor,
        order_id=order.id,
        source_type=CashflowSourceType.ORDER_EVENT.value,
        source_id=event.event_no,
        operator_user_ids=operator_ids,
        note=note or f"{rebate_type} 返点",
        form_extra={**(form_extra or {}), "rebate_record_id": record.id},
        form_extra_scope="INVREBATE",
        user=user,
    )
    record_audit(
        session,
        action=AuditAction.REBATE_CREATE,
        entity_type="rebate_record",
        entity_id=record.rebate_no,
        actor=actor,
        after={
            "source_order": order.order_no,
            "amount": str(amount),
            "event_no": event.event_no,
            "flow_no": flow.flow_no,
        },
    )
    return record


def _validate_operator_user_ids(session: Session, operator_user_ids: list[int] | None) -> list[int] | None:
    if operator_user_ids is None:
        return None
    if len(set(operator_user_ids)) != len(operator_user_ids):
        raise Validation("操作人不能重复选择", details={"field": "operator_user_ids"})
    active_ids = set(session.scalars(select(User.id).where(User.id.in_(operator_user_ids), User.is_active.is_(True))))
    if active_ids != set(operator_user_ids):
        raise Validation("所选操作人不存在或已停用", details={"field": "operator_user_ids"})
    return operator_user_ids


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


def update_rebate(
    session: Session,
    rebate_id: int,
    *,
    actor: str,
    amount: Any = None,
    collected_on: date | None = None,
    note: str | None = None,
    operator_user_ids: list[int] | None = None,
    form_extra: dict[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> RebateRecord:
    record = get_rebate(session, rebate_id, user=user)
    before = {"amount": str(record.amount), "collected_on": str(record.collected_on), "note": record.note}
    if amount is not None:
        new_amount = _positive(amount, field="amount")
        record.amount = new_amount
    if collected_on is not None:
        record.collected_on = collected_on
    if note is not None:
        record.note = note
    if operator_user_ids is not None:
        record.operator_user_ids = _validate_operator_user_ids(session, operator_user_ids)
    if form_extra is not None:
        record.form_extra = validate_form_extra(session, order_type_code="INVREBATE", values=form_extra) or None
    action_event = _rebate_action_event(session, record)
    if action_event is not None:
        action_event.amount = record.amount
        action_event.occurred_on = record.collected_on
        action_event.note = record.note
        action_event.updated_by = actor
        flow = session.scalar(select(Cashflow).where(
            Cashflow.source_type == CashflowSourceType.ORDER_EVENT.value,
            Cashflow.source_id == action_event.event_no,
        ))
        if flow is not None:
            flow.amount = record.amount
            flow.occurred_on = record.collected_on
            flow.note = record.note or flow.note
            flow.updated_by = actor
    record.updated_by = actor
    session.flush()
    record_audit(session, action=AuditAction.REBATE_UPDATE, entity_type="rebate_record", entity_id=record.rebate_no, actor=actor, before=before, after={"amount": str(record.amount), "collected_on": str(record.collected_on), "note": record.note})
    return record


def _rebate_action_event(session: Session, record: RebateRecord) -> OrderEvent | None:
    """查找新动作模型的返点事件；旧记录没有该事件，继续走兼容口径。

    供 update_rebate 编辑时同步事件与资金流水的金额/日期，保持报表同源。
    """
    events = session.scalars(
        select(OrderEvent).where(
            OrderEvent.order_id == record.source_order_id,
            OrderEvent.event_type == "REBATE",
        )
    ).all()
    for event in events:
        if (event.form_extra or {}).get("rebate_record_id") == record.id:
            return event
    return None


__all__ = [
    "create_rebate",
    "get_rebate",
    "list_rebates",
    "update_rebate",
]

