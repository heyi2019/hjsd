"""订单详情事件、流水与操作人查询装配。"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.enums import CashflowSourceType, EventType
from app.domain.foundation import Pool
from app.domain.trade import Cashflow, OrderEvent
from app.domain.users import User
from app.shared.order_amounts import is_deposit_loss_flow
from app.business.router_output import cancellable_by_event

from .execution_schemas import ExecutionCashflowOut, ExecutionEventOut


@dataclass(frozen=True)
class DetailEventContext:
    events_by_order: dict[int, list[ExecutionEventOut]]
    event_cashflows: dict[int, ExecutionCashflowOut]
    order_cashflows: dict[int, list[ExecutionCashflowOut]]
    deposit_loss_flow_nos: set[str]
    action_model_rebate_nos: set[str]


def load_event_context(db: Session, order_ids: list[int]) -> DetailEventContext:
    if not order_ids:
        return DetailEventContext({}, {}, {}, set(), set())

    events = list(
        db.scalars(
            select(OrderEvent)
            .where(OrderEvent.order_id.in_(order_ids), OrderEvent.is_posted.is_(True))
            .order_by(OrderEvent.occurred_on, OrderEvent.id)
        ).all()
    )
    action_model_rebate_nos = {
        event.source_id
        for event in events
        if event.event_type == EventType.REBATE.value
        and event.source_type == CashflowSourceType.REBATE.value
        and event.source_id
    }
    event_nos = [event.event_no for event in events]
    event_cashflows: dict[int, ExecutionCashflowOut] = {}
    order_cashflows: dict[int, list[ExecutionCashflowOut]] = {}
    deposit_loss_flow_nos: set[str] = set()
    if event_nos:
        for flow, pool in db.execute(
            select(Cashflow, Pool)
            .join(Pool, Pool.id == Cashflow.pool_id)
            .where(
                Cashflow.source_type == CashflowSourceType.ORDER_EVENT.value,
                Cashflow.source_id.in_(event_nos),
            )
        ).all():
            if is_deposit_loss_flow(
                accounting_attribute=flow.accounting_attribute,
                direction=flow.direction,
                category=flow.category,
            ):
                deposit_loss_flow_nos.add(flow.flow_no)
            event_cashflows[flow.source_id] = _cashflow_output(flow, pool)
    for flow, pool in db.execute(
        select(Cashflow, Pool)
        .join(Pool, Pool.id == Cashflow.pool_id)
        .where(
            Cashflow.order_id.in_(order_ids),
            Cashflow.source_type != CashflowSourceType.ORDER_EVENT.value,
        )
        .order_by(Cashflow.occurred_on, Cashflow.id)
    ).all():
        if is_deposit_loss_flow(
            accounting_attribute=flow.accounting_attribute,
            direction=flow.direction,
            category=flow.category,
        ):
            deposit_loss_flow_nos.add(flow.flow_no)
        order_cashflows.setdefault(flow.order_id, []).append(_cashflow_output(flow, pool))

    operator_ids = {uid for event in events for uid in (event.operator_user_ids or [])}
    operator_ids.update(
        uid
        for flow in [*event_cashflows.values(), *[item for flows in order_cashflows.values() for item in flows]]
        for uid in (flow.operator_user_ids or [])
    )
    operator_names = {
        user.id: user.display_name or user.username
        for user in db.scalars(select(User).where(User.id.in_(operator_ids))).all()
    } if operator_ids else {}
    for flow in [*event_cashflows.values(), *[item for flows in order_cashflows.values() for item in flows]]:
        flow.operator = "、".join(operator_names.get(uid, f"用户 {uid}") for uid in (flow.operator_user_ids or [])) or "-"
    cancellable_amounts = cancellable_by_event(events)
    events_by_order: dict[int, list[ExecutionEventOut]] = {}
    for event in events:
        selected_operator_names = [operator_names.get(uid, f"用户 {uid}") for uid in (event.operator_user_ids or [])]
        events_by_order.setdefault(event.order_id, []).append(
            ExecutionEventOut(
                id=event.id,
                event_no=event.event_no,
                event_type=event.event_type,
                operation_type=(event.form_extra or {}).get("operation_type"),
                rebate_type=(event.form_extra or {}).get("rebate_type"),
                amount=event.amount,
                cancellable_amount=cancellable_amounts[event.id],
                occurred_on=event.occurred_on,
                occurred_at=event.posted_at or event.created_at,
                created_at=event.created_at,
                posted_at=event.posted_at,
                pool_id=event.pool_id,
                offset_event_id=event.offset_event_id,
                portion=event.portion,
                delivery_direction=(event.form_extra or {}).get("delivery_direction"),
                is_posted=event.is_posted,
                reason=event.reason,
                note=event.note,
                form_extra=dict(event.form_extra or {}),
                cashflow=event_cashflows.get(event.event_no),
                operator="、".join(selected_operator_names) or "-",
                operator_user_ids=event.operator_user_ids,
                operator_names=selected_operator_names,
            )
        )
    return DetailEventContext(
        events_by_order=events_by_order,
        event_cashflows=event_cashflows,
        order_cashflows=order_cashflows,
        deposit_loss_flow_nos=deposit_loss_flow_nos,
        action_model_rebate_nos=action_model_rebate_nos,
    )


def _cashflow_output(flow: Cashflow, pool: Pool) -> ExecutionCashflowOut:
    return ExecutionCashflowOut(
        flow_no=flow.flow_no,
        pool_id=pool.id,
        pool_name=pool.name,
        occurred_on=flow.occurred_on,
        occurred_at=flow.created_at,
        direction=flow.direction,
        category=flow.category,
        amount=flow.amount,
        note=flow.note,
        operator="-",
        operator_user_ids=flow.operator_user_ids,
    )
