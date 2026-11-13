"""订单详情事件、流水与操作人查询装配。"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.enums import EventType
from app.domain.foundation import Pool
from app.domain.trade import Cashflow, OrderEvent
from app.domain.users import User
from app.orders.amounts import is_deposit_loss_flow
from app.orders.router_output import cancellable_by_event

from ..schemas import ExecutionCashflowOut, ExecutionEventOut


@dataclass(frozen=True)
class DetailEventContext:
    events_by_order: dict[int, list[ExecutionEventOut]]
    event_cashflows: dict[int, ExecutionCashflowOut]
    order_cashflows: dict[int, list[ExecutionCashflowOut]]
    deposit_loss_flow_nos: set[str]
    action_model_rebate_ids: set[int]


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
    action_model_rebate_ids = {
        int((event.form_extra or {}).get("rebate_record_id"))
        for event in events
        if event.event_type == EventType.REBATE.value
        and str((event.form_extra or {}).get("rebate_record_id", "")).isdigit()
    }
    event_ids = [event.id for event in events]
    event_cashflows: dict[int, ExecutionCashflowOut] = {}
    order_cashflows: dict[int, list[ExecutionCashflowOut]] = {}
    deposit_loss_flow_nos: set[str] = set()
    if event_ids:
        for flow, pool in db.execute(
            select(Cashflow, Pool)
            .join(Pool, Pool.id == Cashflow.pool_id)
            .where(Cashflow.order_event_id.in_(event_ids))
        ).all():
            if is_deposit_loss_flow(
                accounting_attribute=flow.accounting_attribute,
                direction=flow.direction,
                category=flow.category,
            ):
                deposit_loss_flow_nos.add(flow.flow_no)
            event_cashflows[flow.order_event_id] = _cashflow_output(flow, pool)
    for flow, pool in db.execute(
        select(Cashflow, Pool)
        .join(Pool, Pool.id == Cashflow.pool_id)
        .where(Cashflow.order_id.in_(order_ids), Cashflow.order_event_id.is_(None))
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
    operator_names = {
        user.id: user.display_name
        for user in db.scalars(select(User).where(User.id.in_(operator_ids))).all()
    } if operator_ids else {}
    cancellable_amounts = cancellable_by_event(events)
    events_by_order: dict[int, list[ExecutionEventOut]] = {}
    for event in events:
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
                delivery_mode=event.delivery_mode,
                delivery_direction=(event.form_extra or {}).get("delivery_direction"),
                is_posted=event.is_posted,
                reason=event.reason,
                note=event.note,
                form_extra=dict(event.form_extra or {}),
                cashflow=event_cashflows.get(event.id),
                operator=event.created_by,
                operator_user_ids=event.operator_user_ids,
                operator_names=[operator_names.get(uid, f"用户 {uid}") for uid in (event.operator_user_ids or [])],
            )
        )
    return DetailEventContext(
        events_by_order=events_by_order,
        event_cashflows=event_cashflows,
        order_cashflows=order_cashflows,
        deposit_loss_flow_nos=deposit_loss_flow_nos,
        action_model_rebate_ids=action_model_rebate_ids,
    )


def _cashflow_output(flow: Cashflow, pool: Pool) -> ExecutionCashflowOut:
    return ExecutionCashflowOut(
        flow_no=flow.flow_no,
        pool_name=pool.name,
        occurred_on=flow.occurred_on,
        occurred_at=flow.created_at,
        direction=flow.direction,
        nature=flow.nature,
        category=flow.category,
        amount=flow.amount,
        note=flow.note,
        operator=flow.created_by,
    )
