"""orders.router_outputs.detail：订单详情输出装配。"""
from __future__ import annotations

from collections.abc import Sequence
from collections import defaultdict

from sqlalchemy import or_, select, tuple_
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
from app.business import schemas
from app.business.orders.output_labels import _selected_operator_label
from app.business.orders.router_outputs._shared import (
    _apply_common_output,
    _event_output,
    _operator_names,
    cancellable_by_event,
)


def _index_events_by_number(events: Sequence[OrderEvent]) -> dict[str, OrderEvent]:
    indexed: dict[str, OrderEvent] = {}
    for event in events:
        indexed.setdefault(event.event_no, event)
    return indexed


def _order_detail_output(
    db: Session, order, user: CurrentUser, *, preloaded: dict | None = None
) -> schemas.OrderDetailOut:
    """订单详情统一返回主字段和执行事件，避免前端再拼接隐式查询。"""
    output = schemas.OrderDetailOut.model_validate(order)
    _apply_common_output(output, order)
    events = preloaded["events"].get(order.id, []) if preloaded is not None else db.scalars(
        select(OrderEvent)
        .where(OrderEvent.order_id == order.id)
        .order_by(OrderEvent.occurred_on, OrderEvent.id)
    ).all()
    operator_names = preloaded["operator_names"] if preloaded is not None else _operator_names(db, events)
    cancellable = cancellable_by_event(list(events))
    output.events = [_event_output(event, operator_names, cancellable) for event in events]
    if user.has(PERM_FINANCE_READ):
        events_by_number = _index_events_by_number(events)
        cashflows = preloaded["cashflows"].get(order.id, []) if preloaded is not None else db.scalars(
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
                        events_by_number.get(item.source_id),
                        operator_names,
                    ) or "-",
                }
            )
            for item in cashflows
        ]
        rebates = preloaded["rebates"].get(order.id, []) if preloaded is not None else db.scalars(
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
    installments = preloaded["installments"].get(order.id, []) if preloaded is not None else db.scalars(
        select(Installment).where(Installment.order_id == order.id).order_by(Installment.id.desc())
    ).all()
    installment = installments[0] if installments else None
    if installment is not None:
        output.installment = schemas.OrderInstallmentOut.model_validate(installment)
        schedules = preloaded["schedules"].get(installment.id, []) if preloaded is not None else db.scalars(
            select(InstallmentSchedule)
            .where(InstallmentSchedule.installment_id == installment.id)
            .order_by(InstallmentSchedule.period_no)
        ).all()
        output.installment_schedule = [
            schemas.OrderScheduleOut.model_validate(item) for item in schedules
        ]
    attachment_refs = [("order", order.order_no)]
    attachment_refs.extend(("order_event", event.event_no) for event in events)
    attachment_refs.extend(("installment", item.inst_no) for item in installments)
    if user.has(PERM_FINANCE_READ):
        attachment_refs.extend(("cashflow", item.flow_no) for item in cashflows)
    if attachment_refs:
        if preloaded is not None:
            attachments = sorted(
                (item for ref in attachment_refs for item in preloaded["attachments"].get(ref, [])),
                key=lambda item: (item.created_at, item.id),
            )
        else:
            attachments = db.scalars(
                select(Attachment).where(Attachment.deleted_at.is_(None), or_(*(
                    (Attachment.entity_type == entity_type) & (Attachment.entity_id == entity_id)
                    for entity_type, entity_id in attachment_refs
                ))).order_by(Attachment.created_at, Attachment.id)
            ).all()
        output.attachments = [
            schemas.AttachmentOut.model_validate(item)
            for item in attachments
        ]
    if user.has(PERM_AUDIT_READ):
        audit_rows = preloaded["audits"].get(order.order_no, []) if preloaded is not None else db.scalars(
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


def _order_details_output(db: Session, orders: Sequence, user: CurrentUser) -> list[schemas.OrderDetailOut]:
    if not orders:
        return []
    if len(orders) > 500:
        return [
            detail
            for start in range(0, len(orders), 500)
            for detail in _order_details_output(db, orders[start:start + 500], user)
        ]
    ids = [order.id for order in orders]
    data = {name: defaultdict(list) for name in ("events", "cashflows", "rebates", "installments", "schedules", "attachments", "audits")}
    events = db.scalars(select(OrderEvent).where(OrderEvent.order_id.in_(ids)).order_by(OrderEvent.occurred_on, OrderEvent.id)).all()
    for event in events:
        data["events"][event.order_id].append(event)
    data["operator_names"] = {}
    for start in range(0, len(events), 500):
        data["operator_names"].update(_operator_names(db, events[start:start + 500]))
    if user.has(PERM_FINANCE_READ):
        for flow in db.scalars(select(Cashflow).where(Cashflow.order_id.in_(ids)).order_by(Cashflow.occurred_on, Cashflow.id)).all():
            data["cashflows"][flow.order_id].append(flow)
        for rebate in db.scalars(select(RebateRecord).where(RebateRecord.source_order_id.in_(ids)).order_by(RebateRecord.id)).all():
            data["rebates"][rebate.source_order_id].append(rebate)
    installments = db.scalars(select(Installment).where(Installment.order_id.in_(ids)).order_by(Installment.id.desc())).all()
    for installment in installments:
        data["installments"][installment.order_id].append(installment)
    latest_ids = [items[0].id for items in data["installments"].values()]
    if latest_ids:
        for schedule in db.scalars(select(InstallmentSchedule).where(InstallmentSchedule.installment_id.in_(latest_ids)).order_by(InstallmentSchedule.period_no)).all():
            data["schedules"][schedule.installment_id].append(schedule)
    refs = {("order", order.order_no) for order in orders}
    refs.update(("order_event", event.event_no) for event in events)
    refs.update(("installment", item.inst_no) for item in installments)
    if user.has(PERM_FINANCE_READ):
        refs.update(("cashflow", item.flow_no) for flows in data["cashflows"].values() for item in flows)
    if refs:
        ref_list = list(refs)
        for start in range(0, len(ref_list), 5000):
            statement = select(Attachment).where(
                Attachment.deleted_at.is_(None),
                tuple_(Attachment.entity_type, Attachment.entity_id).in_(ref_list[start:start + 5000]),
            )
            for attachment in db.scalars(statement).all():
                data["attachments"][(attachment.entity_type, attachment.entity_id)].append(attachment)
    if user.has(PERM_AUDIT_READ):
        for audit in db.scalars(select(AuditLog).where(AuditLog.entity_type == "order", AuditLog.entity_id.in_([order.order_no for order in orders])).order_by(AuditLog.id)).all():
            data["audits"][audit.entity_id].append(audit)
    return [_order_detail_output(db, order, user, preloaded=data) for order in orders]
