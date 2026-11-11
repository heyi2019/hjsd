"""parties.leads：客户需求（线索）的建档、编辑、转单与关闭。

规则来源：CUS-01。转单只允许 `OPEN` 状态，转单后写入 `converted_order_id`。
"""
from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Conflict, NotFound, Validation
from app.core.like_pattern import like_contains
from app.core.money import to_money
from app.core.numbering import allocate_number
from app.core.security import CurrentUser, owner_scope_filter
from app.domain.enums import AuditAction, EntityType, LeadStatus, LeadType, SequenceKey
from app.domain.parties import CustomerLead
from app.domain.trade import Order

from ._common import _UNSET, _normalize_extra_values, _required_text, _validate_owner_id
from .customer_merge import assert_customer_usable
from .fields import _validate_required_extras, set_extra_values

def _get_lead_for_user(
    session: Session, lead_id: int, user: CurrentUser | None = None
) -> CustomerLead:
    lead = session.get(CustomerLead, lead_id)
    if lead is None:
        raise NotFound("客户需求不存在", details={"lead_id": lead_id})
    if user is not None:
        scope = owner_scope_filter(CustomerLead.owner_id, user, session)
        if scope is not None and not session.scalar(
            select(CustomerLead.id).where(CustomerLead.id == lead_id, scope)
        ):
            raise NotFound("客户需求不存在", details={"lead_id": lead_id})
    return lead


def get_lead(
    session: Session, lead_id: int, user: CurrentUser | None = None
) -> CustomerLead:
    return _get_lead_for_user(session, lead_id, user)


def create_lead(
    session: Session,
    *,
    customer_id: int,
    request_type: str,
    target: str,
    actor: str,
    budget: Decimal | None = None,
    owner_id: int | None = None,
    note: str | None = None,
    user: CurrentUser | None = None,
    extra_values: Mapping[str, Any] | None = None,
) -> CustomerLead:
    customer = assert_customer_usable(session, customer_id, user=user)
    try:
        LeadType(request_type)
    except ValueError as exc:
        raise Validation(
            f"需求类型必须为 {LeadType.values()}",
            details={"field": "request_type", "value": request_type},
        ) from exc
    target_text = _required_text(target, message="需求目标必填", field="target")
    if budget is not None and to_money(budget) < 0:
        raise Validation("需求预算不能为负数", details={"field": "budget"})
    _validate_owner_id(session, owner_id)
    lead = CustomerLead(
        lead_no=allocate_number(session, SequenceKey.LEAD),
        customer_id=customer.id,
        request_type=request_type,
        budget=to_money(budget) if budget is not None else None,
        target=target_text,
        owner_id=owner_id,
        note=note,
        status=LeadStatus.OPEN.value,
        created_by=actor,
        updated_by=actor,
    )
    session.add(lead)
    session.flush()
    set_extra_values(
        session,
        entity_type=EntityType.LEAD.value,
        entity_id=lead.id,
        values=(extra_values or {}).items(),
        require_all=True,
    )
    record_audit(
        session,
        action=AuditAction.LEAD_CREATE,
        entity_type="lead",
        entity_id=lead.lead_no,
        actor=actor,
        after={"customer_id": customer.id, "request_type": request_type},
    )
    return lead


def list_leads(
    session: Session,
    *,
    customer_id: int | None = None,
    status: str | None = None,
    keyword: str | None = None,
    user: CurrentUser | None = None,
) -> list[CustomerLead]:
    stmt = select(CustomerLead)
    if customer_id is not None:
        stmt = stmt.where(CustomerLead.customer_id == customer_id)
    if status is not None:
        try:
            LeadStatus(status)
        except ValueError as exc:
            raise Validation(
                f"需求状态必须为 {LeadStatus.values()}",
                details={"field": "status", "value": status},
            ) from exc
        stmt = stmt.where(CustomerLead.status == status)
    if keyword:
        pattern, escape = like_contains(keyword)
        stmt = stmt.where(
            or_(
                CustomerLead.lead_no.ilike(pattern, escape=escape),
                CustomerLead.target.ilike(pattern, escape=escape),
            )
        )
    if user is not None:
        scope = owner_scope_filter(CustomerLead.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    return list(session.scalars(stmt.order_by(CustomerLead.id.desc())).all())


def update_lead(
    session: Session,
    lead_id: int,
    *,
    actor: str,
    user: CurrentUser | None = None,
    extra_values: Mapping[str, Any] | None | object = _UNSET,
    **fields: Any,
) -> CustomerLead:
    lead = _get_lead_for_user(session, lead_id, user)
    if lead.status != LeadStatus.OPEN.value:
        raise Conflict("已转单或关闭的需求不可编辑", details={"lead_no": lead.lead_no})
    allowed = {"budget", "target", "owner_id", "note"}
    unknown = set(fields) - allowed
    if unknown:
        raise Validation("需求更新字段不受支持", details={"fields": sorted(unknown)})
    before = {
        name: (
            str(getattr(lead, name))
            if isinstance(getattr(lead, name), Decimal)
            else getattr(lead, name)
        )
        for name in fields
    }
    if "target" in fields:
        fields["target"] = _required_text(
            fields["target"], message="需求目标必填", field="target"
        )
    if "budget" in fields and fields["budget"] is not None:
        fields["budget"] = to_money(fields["budget"])
        if fields["budget"] < 0:
            raise Validation("需求预算不能为负数", details={"field": "budget"})
    if "owner_id" in fields:
        _validate_owner_id(session, fields["owner_id"])
    for name, value in fields.items():
        setattr(lead, name, value)
    lead.updated_by = actor
    session.flush()
    if extra_values is not _UNSET:
        values = _normalize_extra_values(extra_values)
        _validate_required_extras(
            session, EntityType.LEAD.value, values, partial=True
        )
        set_extra_values(
            session,
            entity_type=EntityType.LEAD.value,
            entity_id=lead.id,
            values=values.items(),
        )
    record_audit(
        session,
        action=AuditAction.LEAD_UPDATE,
        entity_type="lead",
        entity_id=lead.lead_no,
        actor=actor,
        before=before,
        after={
            name: (
                str(getattr(lead, name))
                if isinstance(getattr(lead, name), Decimal)
                else getattr(lead, name)
            )
            for name in fields
        },
    )
    return lead


def convert_lead(
    session: Session,
    lead_id: int,
    *,
    order_id: int,
    actor: str,
    user: CurrentUser | None = None,
    extra_values: Mapping[str, Any] | None = None,
) -> CustomerLead:
    lead = _get_lead_for_user(session, lead_id, user)
    if lead.status != LeadStatus.OPEN.value:
        raise Conflict("只有 OPEN 需求可以转单", details={"lead_no": lead.lead_no})
    order = session.get(Order, order_id)
    if order is None:
        raise NotFound("订单不存在", details={"order_id": order_id})
    scope = owner_scope_filter(Order.owner_id, user, session) if user is not None else None
    if scope is not None and not session.scalar(
        select(Order.id).where(Order.id == order_id, scope)
    ):
        raise NotFound("订单不存在", details={"order_id": order_id})
    lead.status = LeadStatus.CONVERTED.value
    lead.converted_order_id = order.id
    lead.updated_by = actor
    if extra_values:
        set_extra_values(session, entity_type=EntityType.LEAD.value, entity_id=lead.id, values=extra_values.items())
    session.flush()
    record_audit(
        session,
        action=AuditAction.LEAD_CONVERT,
        entity_type="lead",
        entity_id=lead.lead_no,
        actor=actor,
        after={"status": lead.status, "converted_order_no": order.order_no},
    )
    return lead


def close_lead(
    session: Session,
    lead_id: int,
    *,
    reason: str,
    actor: str,
    user: CurrentUser | None = None,
    extra_values: Mapping[str, Any] | None = None,
) -> CustomerLead:
    lead = _get_lead_for_user(session, lead_id, user)
    if lead.status != LeadStatus.OPEN.value:
        raise Conflict("只有 OPEN 需求可以关闭", details={"lead_no": lead.lead_no})
    normalized = _required_text(reason, message="关闭需求必须填写原因", field="reason")
    lead.status = LeadStatus.CLOSED.value
    lead.closed_reason = normalized
    lead.updated_by = actor
    if extra_values:
        set_extra_values(session, entity_type=EntityType.LEAD.value, entity_id=lead.id, values=extra_values.items())
    session.flush()
    record_audit(
        session,
        action=AuditAction.LEAD_CLOSE,
        entity_type="lead",
        entity_id=lead.lead_no,
        actor=actor,
        after={"status": lead.status},
        reason=normalized,
    )
    return lead
