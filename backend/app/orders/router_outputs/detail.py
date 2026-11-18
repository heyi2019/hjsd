"""orders.router_outputs.detail：订单详情输出装配。"""
from __future__ import annotations

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.security import CurrentUser, PERM_AUDIT_READ, PERM_FINANCE_READ
from app.domain.attachments import Attachment
from app.domain.foundation import AuditLog
from app.domain.trade import (
    Cashflow,
    Installment,
    InstallmentSchedule,
    OrderEvent,
    RebateRecord,
)
from app.orders import schemas
from app.orders.output_labels import _selected_operator_label
from app.orders.router_outputs._shared import (
    _apply_common_output,
    _event_output,
    _operator_names,
    cancellable_by_event,
)


def _order_detail_output(
    db: Session, order, user: CurrentUser
) -> schemas.OrderDetailOut:
    """订单详情统一返回主字段和执行事件，避免前端再拼接隐式查询。"""
    output = schemas.OrderDetailOut.model_validate(order)
    _apply_common_output(output, order)
    events = db.scalars(
        select(OrderEvent)
        .where(OrderEvent.order_id == order.id)
        .order_by(OrderEvent.occurred_on, OrderEvent.id)
    ).all()
    operator_names = _operator_names(db, events)
    cancellable = cancellable_by_event(list(events))
    output.events = [_event_output(event, operator_names, cancellable) for event in events]
    if user.has(PERM_FINANCE_READ):
        cashflows = db.scalars(
            select(Cashflow)
            .where(Cashflow.order_id == order.id)
            .order_by(Cashflow.occurred_on, Cashflow.id)
        ).all()
        output.cashflows = [
            schemas.OrderCashflowOut.model_validate(
                {
                    "flow_no": item.flow_no,
                    "pool_id": item.pool_id,
                    "occurred_on": item.occurred_on,
                    "category": item.category,
                    "direction": item.direction,
                    "amount": item.amount,
                    "source_type": item.source_type,
                    "source_id": item.source_id,
                    "note": item.note,
                    "operator": _selected_operator_label(
                        next((event for event in events if event.event_no == item.source_id), None),
                        operator_names,
                    ) or "-",
                }
            )
            for item in cashflows
        ]
        rebates = db.scalars(
            select(RebateRecord)
            .where(RebateRecord.source_order_id == order.id)
            .order_by(RebateRecord.id)
        ).all()
        output.rebates = [
            schemas.OrderRebateOut.model_validate(
                {
                    "id": item.id,
                    "rebate_no": item.rebate_no,
                    "rebate_type": item.rebate_type,
                    "channel": item.channel,
                    "amount": item.amount,
                    "collected_on": item.collected_on,
                    "note": item.note,
                    "created_at": item.created_at,
                    "operator": item.created_by,
                }
            )
            for item in rebates
        ]
    installment = db.scalar(
        select(Installment).where(Installment.order_id == order.id)
    )
    if installment is not None:
        output.installment = schemas.OrderInstallmentOut.model_validate(installment)
        schedules = db.scalars(
            select(InstallmentSchedule)
            .where(InstallmentSchedule.installment_id == installment.id)
            .order_by(InstallmentSchedule.period_no)
        ).all()
        output.installment_schedule = [
            schemas.OrderScheduleOut.model_validate(item) for item in schedules
        ]
    attachment_refs = [("order", order.order_no)]
    attachment_refs.extend(("order_event", event.event_no) for event in events)
    if installment is not None:
        attachment_refs.append(("installment", installment.inst_no))
    if user.has(PERM_FINANCE_READ):
        attachment_refs.extend(("cashflow", item.flow_no) for item in cashflows)
    if attachment_refs:
        output.attachments = [
            schemas.AttachmentOut.model_validate(item)
            for item in db.scalars(
                select(Attachment)
                .where(
                    Attachment.deleted_at.is_(None),
                    or_(*(
                        (Attachment.entity_type == entity_type)
                        & (Attachment.entity_id == entity_id)
                        for entity_type, entity_id in attachment_refs
                    )),
                )
                .order_by(Attachment.created_at, Attachment.id)
            ).all()
        ]
    if user.has(PERM_AUDIT_READ):
        audit_rows = db.scalars(
            select(AuditLog)
            .where(
                AuditLog.entity_type == "order",
                AuditLog.entity_id == order.order_no,
            )
            .order_by(AuditLog.id)
        ).all()
        output.audit = [
            schemas.OrderAuditOut.model_validate(
                {
                    "id": item.id,
                    "action": item.action,
                    "entity_type": item.entity_type,
                    "entity_id": item.entity_id,
                    "actor": item.actor,
                    "reason": item.reason,
                    "request_id": item.request_id,
                    "occurred_at": item.occurred_at,
                }
            )
            for item in audit_rows
        ]
    return output
