"""finance 返点服务（REB-01）。"""
from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.shared.business_numbering import rebate_no as order_rebate_no
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.security import CurrentUser
from app.shared.scope import owner_scope_filter
from app.domain.enums import (
    AuditAction,
    CashflowSourceType,
    Direction,
    OrderStatus,
    RebateType,
)
from app.domain.foundation import Pool
from app.domain.trade import Cashflow, OrderEvent, RebateRecord, Reconciliation
from app.settings.field_definitions.pools import require_default_pool
from app.shared.order_access import get_order
from app.shared.operation_operators import validate_optional_operator_ids
from app.business.events import post_event
from app.shared.form_field_rules import validate_form_extra
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
    operator_ids = validate_optional_operator_ids(session, operator_user_ids)
    field_context = {
        "source_order_id": source_order_id, "rebate_type": rebate_type, "amount": amount,
        "collected_on": collected_on, "channel": channel, "note": note, "operator_user_ids": operator_ids,
    }
    checked_extra = validate_form_extra(session, order_type_code="INVREBATE", values=form_extra, context=field_context)
    record = RebateRecord(
        rebate_no=rebate_no,
        source_order_id=order.id,
        rebate_type=rebate_type,
        channel=channel,
        amount=amount,
        collected_on=collected_on,
        note=note,
        operator_user_ids=operator_ids,
        form_extra=checked_extra or None,
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
        form_extra=checked_extra,
        form_extra_context=field_context,
        source_type=CashflowSourceType.REBATE.value,
        source_id=record.rebate_no,
        user=user,
    )
    pool = require_default_pool(session)
    from app.funds.cashflows import create_cashflow

    flow = create_cashflow(
        session,
        pool_id=pool.id,
        occurred_on=collected_on,
        direction=Direction.IN.value,
        category="REBATE",
        amount=amount,
        actor=actor,
        order_id=order.id,
        source_type=CashflowSourceType.ORDER_EVENT.value,
        source_id=event.event_no,
        operator_user_ids=operator_ids,
        note=note or f"{rebate_type} 返点",
        form_extra=checked_extra,
        form_extra_scope="INVREBATE",
        form_extra_context=field_context,
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
    for_update: bool = False,
) -> RebateRecord:
    record = session.get(RebateRecord, rebate_id, with_for_update=for_update, populate_existing=for_update)
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
    # 与订单详情编辑和对账统一锁顺序：账户 → 返点 → 事件 → 流水。
    visible = get_rebate(session, rebate_id, user=user)
    prior_flow = session.execute(select(Cashflow.id, Cashflow.pool_id).join(
        OrderEvent, OrderEvent.event_no == Cashflow.source_id,
    ).where(
        OrderEvent.order_id == visible.source_order_id,
        OrderEvent.event_type == "REBATE",
        OrderEvent.source_type == CashflowSourceType.REBATE.value,
        OrderEvent.source_id == visible.rebate_no,
        Cashflow.source_type == CashflowSourceType.ORDER_EVENT.value,
    )).first()
    if prior_flow is not None:
        session.scalars(select(Pool.id).where(Pool.id == prior_flow.pool_id).with_for_update(key_share=True)).one()
    record = get_rebate(session, rebate_id, user=user, for_update=True)
    action_event = _rebate_action_event(session, record)
    flow = None
    if action_event is not None:
        flow = session.scalar(select(Cashflow).where(
            Cashflow.source_type == CashflowSourceType.ORDER_EVENT.value,
            Cashflow.source_id == action_event.event_no,
        ).with_for_update().execution_options(populate_existing=True))
        if flow is not None and (prior_flow is None or flow.id != prior_flow.id or flow.pool_id != prior_flow.pool_id):
            raise Conflict("返点关联资金账户已变化，请刷新后重试")
        if flow is not None and session.scalar(select(Cashflow.id).where(
            Cashflow.source_type == CashflowSourceType.REVERSAL.value,
            Cashflow.source_id == flow.flow_no,
        )) is not None:
            raise Validation("已冲销的返点不能编辑", details={"rebate_record_id": rebate_id})
    new_amount = _positive(amount, field="amount") if amount is not None else record.amount
    new_date = collected_on if collected_on is not None else record.collected_on
    if flow is not None and (flow.amount != new_amount or flow.occurred_on != new_date):
        earliest_date = min(flow.occurred_on, new_date)
        if session.scalar(select(Reconciliation.id).where(
            Reconciliation.pool_id == flow.pool_id,
            Reconciliation.reconciled_on >= earliest_date,
        )) is not None:
            raise Validation("资金账户已有后续对账记录，不能直接修改")
    before = {"amount": str(record.amount), "collected_on": str(record.collected_on), "note": record.note}
    if amount is not None:
        record.amount = new_amount
    if collected_on is not None:
        record.collected_on = collected_on
    if note is not None:
        record.note = note
    if operator_user_ids is not None:
        record.operator_user_ids = validate_optional_operator_ids(session, operator_user_ids)
    if form_extra is not None:
        record.form_extra = validate_form_extra(session, order_type_code="INVREBATE", values=form_extra) or None
    if action_event is not None:
        action_event.amount = record.amount
        action_event.occurred_on = record.collected_on
        action_event.note = record.note
        action_event.updated_by = actor
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
    """按显式来源 source_type=REBATE + source_id=rebate_no 定位返点事件。

    供 update_rebate 编辑时同步事件与资金流水的金额/日期，保持报表同源。
    """
    return session.scalar(
        select(OrderEvent).where(
            OrderEvent.order_id == record.source_order_id,
            OrderEvent.event_type == "REBATE",
            OrderEvent.source_type == CashflowSourceType.REBATE.value,
            OrderEvent.source_id == record.rebate_no,
        ).with_for_update().execution_options(populate_existing=True)
    )


__all__ = [
    "create_rebate",
    "get_rebate",
    "list_rebates",
    "update_rebate",
]

