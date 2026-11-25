"""orders.router_outputs.detail：订单详情输出装配。"""
from __future__ import annotations

from collections.abc import Sequence
from collections import defaultdict
import json
from typing import Any

from sqlalchemy import or_, select, tuple_
from sqlalchemy.orm import Session

from app.core.security import CurrentUser, PERM_AUDIT_READ, PERM_FINANCE_READ
from app.domain.attachments import Attachment
from app.domain.foundation import AuditLog, Pool
from app.domain.trade import (
    Cashflow,
    Installment,
    Order,
    InstallmentSchedule,
    OrderEvent,
    RebateRecord,
)
from app.business.orders import schemas
from app.business.orders.output_labels import _selected_operator_label
from app.business.orders.router_outputs._shared import (
    _apply_common_output,
    _event_output,
    _operator_names,
    cancellable_by_event,
)


def _order_detail_output(
    db: Session, order: Order, user: CurrentUser, *, preloaded: dict[str, Any] | None = None
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
    event_numbers = {event.id: event.event_no for event in events}
    output.events = [
        _event_output(event, operator_names, cancellable).model_copy(update={
            "pool_id": event.pool_id if event.pool_id is None or (user.has(PERM_FINANCE_READ) and user.can_see_pool(event.pool_id)) else None,
            "import_form_extra": json.dumps(event.form_extra or {}, ensure_ascii=False, separators=(",", ":")),
            "import_parent_no": event_numbers.get(parent) if isinstance((parent := (event.form_extra or {}).get("consignment_event_id")), int) and not isinstance(parent, bool) else None,
            "import_sequence": event.id,
            "import_offset_no": event_numbers.get(event.offset_event_id),
            "import_is_posted": "是" if event.is_posted else "否",
            "import_source_type": event.source_type,
            "import_source_id": event.source_id,
        }) for event in events
    ]
    if user.has(PERM_FINANCE_READ):
        cashflows = preloaded["cashflows"].get(order.id, []) if preloaded is not None else db.scalars(
            select(Cashflow)
            .where(Cashflow.order_id == order.id)
            .order_by(Cashflow.occurred_on, Cashflow.id)
        ).all()
        if preloaded is not None:
            pool_codes = preloaded["pool_codes"]
        else:
            pool_ids = {flow.pool_id for flow in cashflows}
            pool_codes = dict(db.execute(select(Pool.id, Pool.code).where(Pool.id.in_(pool_ids))).all()) if pool_ids else {}
            operator_names = {**operator_names, **_operator_names(db, cashflows)}
        output.events = [event.model_copy(update={"import_pool_code": pool_codes.get(event.pool_id) if event.pool_id is not None else None}) for event in output.events]
        output.cashflows = [
            schemas.OrderCashflowOut.model_validate(
                {
                    "flow_no": item.flow_no,
                    "pool_id": item.pool_id,
                    "occurred_on": item.occurred_on,
                    "category": item.category,
                    "import_category": item.category,
                    "direction": item.direction,
                    "amount": item.amount,
                    "source_type": item.source_type,
                    "source_id": item.source_id,
                    "import_source_type": item.source_type,
                    "import_source_id": item.source_id,
                    "accounting_attribute": item.accounting_attribute,
                    "pool_code": pool_codes.get(item.pool_id),
                    "note": item.note,
                    "operator": _selected_operator_label(item, operator_names) or "-",
                }
            )
            for item in cashflows if user.can_see_pool(item.pool_id)
        ]
        rebates = preloaded["rebates"].get(order.id, []) if preloaded is not None else db.scalars(
            select(RebateRecord)
            .where(RebateRecord.source_order_id == order.id)
            .order_by(RebateRecord.id)
        ).all()
        flows_by_event: dict[str, list[Cashflow]] = defaultdict(list)
        for flow in cashflows:
            if flow.source_type == "ORDER_EVENT" and flow.source_id:
                flows_by_event[flow.source_id].append(flow)
        rebate_pools = {}
        for event in events:
            linked = flows_by_event.get(event.event_no, [])
            if event.source_type == "REBATE" and event.source_id and len(linked) == 1:
                rebate_pools[event.source_id] = pool_codes.get(linked[0].pool_id)
        visible_event_numbers = {flow.source_id for flow in cashflows if user.can_see_pool(flow.pool_id)}
        visible_rebate_numbers = {
            event.source_id for event in events
            if event.source_type == "REBATE" and event.event_no in visible_event_numbers
        }
        unrestricted = user.is_admin or user.owner_scope == "ALL"
        output.rebates = [
            schemas.OrderRebateOut.model_validate(
                {
                    "id": item.id,
                    "rebate_no": item.rebate_no,
                    "rebate_type": item.rebate_type,
                    "channel": item.channel,
                    "amount": item.amount,
                    "collected_on": item.collected_on,
                    "pool_code": rebate_pools.get(item.rebate_no),
                    "note": item.note,
                    "created_at": item.created_at,
                    "operator": item.created_by,
                }
            )
            for item in rebates if unrestricted or item.rebate_no in visible_rebate_numbers
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
        attachment_refs.extend(
            ("cashflow", item.flow_no) for item in cashflows
            if item.pool_id is not None and user.can_see_pool(item.pool_id)
        )
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
        flows = db.scalars(select(Cashflow).where(Cashflow.order_id.in_(ids)).order_by(Cashflow.occurred_on, Cashflow.id)).all()
        for flow in flows:
            data["cashflows"][flow.order_id].append(flow)
        for start in range(0, len(flows), 500):
            data["operator_names"].update(_operator_names(db, flows[start:start + 500]))
        for rebate in db.scalars(select(RebateRecord).where(RebateRecord.source_order_id.in_(ids)).order_by(RebateRecord.id)).all():
            data["rebates"][rebate.source_order_id].append(rebate)
    pool_ids = {flow.pool_id for flows in data["cashflows"].values() for flow in flows}
    data["pool_codes"] = dict(db.execute(select(Pool.id, Pool.code).where(Pool.id.in_(pool_ids))).all()) if pool_ids else {}
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
