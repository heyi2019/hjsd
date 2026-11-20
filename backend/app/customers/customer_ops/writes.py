"""客户档案写入：建档、变更与状态收口。"""
from __future__ import annotations
from collections.abc import Mapping, Sequence
from typing import Any
from sqlalchemy.orm import Session
from app.shared.audit import record_audit
from app.core.errors import Conflict, ErrorCode, Validation
from app.shared.numbering import allocate_number
from app.core.security import CurrentUser
from app.domain.enums import AuditAction, CustomerStatus, EntityType, SequenceKey
from app.domain.parties import Customer
from app.customers._common import (
    CONTACT_FIELDS, _normalize_extra_values, _required_text, _validate_owner_id,
)
from app.shared.form_values import _validate_extra_values, _validate_required_extras, set_extra_values
from .queries import get_customer

def create_customer(
    session: Session,
    *,
    display_name: str,
    actor: str,
    contact_name: str | None = None,
    phone: str | None = None,
    wechat: str | None = None,
    qq: str | None = None,
    source: str | None = None,
    owner_id: int | None = None,
    tags: Sequence[str] | None = None,
    note: str | None = None,
    extra_values: Mapping[str, Any] | None = None,
) -> Customer:
    name = _required_text(
        display_name, message="称呼/昵称必填", field="display_name"
    )
    _validate_owner_id(session, owner_id)

    extras = _normalize_extra_values(extra_values)
    _validate_required_extras(session, EntityType.CUSTOMER.value, extras, context={
        "display_name": name, "contact_name": contact_name, "phone": phone, "wechat": wechat,
        "qq": qq, "source": source, "owner_id": owner_id, "tags": tags, "note": note,
    })
    if extras:
        _validate_extra_values(
            session,
            entity_type=EntityType.CUSTOMER.value,
            entity_id=None,
            values=extras.items(),
        )

    customer = Customer(
        customer_no=allocate_number(session, SequenceKey.CUSTOMER),
        display_name=name,
        contact_name=contact_name,
        phone=phone,
        wechat=wechat,
        qq=qq,
        source=source,
        owner_id=owner_id,
        tags=list(tags or []),
        note=note,
        status=CustomerStatus.ACTIVE.value,
        created_by=actor,
        updated_by=actor,
    )
    session.add(customer)
    session.flush()
    if extras:
        set_extra_values(
            session,
            entity_type=EntityType.CUSTOMER.value,
            entity_id=customer.id,
            values=extras.items(),
        )
    record_audit(
        session,
        action=AuditAction.CUSTOMER_CREATE,
        entity_type="customer",
        entity_id=customer.customer_no,
        actor=actor,
        after={"display_name": name, "status": customer.status, **({"extra_values": extras} if extras else {})},
    )
    return customer


def update_customer(
    session: Session,
    customer_id: int,
    *,
    actor: str,
    extra_values: Mapping[str, Any] | None = None,
    user: CurrentUser | None = None,
    **fields: Any,
) -> Customer:
    customer = get_customer(session, customer_id, user)
    if customer.status == CustomerStatus.MERGED.value:
        raise Conflict(
            "已合并客户不可修改",
            code=ErrorCode.MERGE_TARGET_INVALID,
            details={"customer_no": customer.customer_no},
        )

    extras = _normalize_extra_values(extra_values)
    if extras:
        _validate_extra_values(
            session,
            entity_type=EntityType.CUSTOMER.value,
            entity_id=customer.id,
            values=extras.items(),
        )

    allowed_fields = {
        "display_name", "contact_name", "phone", "wechat", "qq", "source",
        "owner_id", "tags", "note",
    }
    for name in fields:
        if name not in allowed_fields:
            raise Validation("客户更新字段不受支持", details={"field": name})
    if "owner_id" in fields and user is not None and not user.is_admin and user.owner_scope != "ALL":
        fields["owner_id"] = user.id
    if "owner_id" in fields:
        _validate_owner_id(session, fields["owner_id"])

    normalized_fields: dict[str, Any] = {}
    for name, value in fields.items():
        if name == "display_name":
            if not isinstance(value, str) or not value.strip():
                raise Validation("称呼/昵称不能清空", details={"field": name})
            value = value.strip()
        normalized_fields[name] = value

    _validate_required_extras(
        session, EntityType.CUSTOMER.value, extras, partial=True,
        context={**{key: getattr(customer, key) for key in allowed_fields},
                 **(customer.form_extra or {}), **normalized_fields},
        changed_fields=normalized_fields,
    )

    before = {name: getattr(customer, name) for name in CONTACT_FIELDS}
    changed_contacts = False
    for name, value in normalized_fields.items():
        if getattr(customer, name, None) != value:
            setattr(customer, name, value)
            if name in CONTACT_FIELDS:
                changed_contacts = True
    customer.updated_by = actor
    session.flush()

    saved_extras: dict[str, Any] = {}
    if extras:
        saved_extras = set_extra_values(
            session,
            entity_type=EntityType.CUSTOMER.value,
            entity_id=customer.id,
            values=extras.items(),
        )

    action = AuditAction.CONTACT_WRITE if changed_contacts else AuditAction.CUSTOMER_UPDATE
    record_audit(
        session,
        action=action,
        entity_type="customer",
        entity_id=customer.customer_no,
        actor=actor,
        before=before,
        after={
            **{name: getattr(customer, name) for name in CONTACT_FIELDS},
            **({"extra_values": saved_extras} if saved_extras else {}),
        },
    )
    return customer


def set_customer_status(
    session: Session,
    customer_id: int,
    status: str,
    *,
    actor: str,
    extra_values: Mapping[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> Customer:
    customer = get_customer(session, customer_id, user)
    if status not in CustomerStatus.values():
        raise Validation(
            f"客户状态无效，必须为 {CustomerStatus.values()}",
            details={"field": "status", "value": status},
        )
    if status == CustomerStatus.MERGED.value:
        raise Validation(
            "MERGED 只能由合并动作产生", details={"field": "status", "value": status}
        )
    if customer.status == CustomerStatus.MERGED.value:
        raise Validation(
            "已合并客户不可修改状态",
            code=ErrorCode.MERGE_TARGET_INVALID,
            details={"customer_no": customer.customer_no, "status": customer.status},
        )
    extras = _normalize_extra_values(extra_values)
    if extras:
        _validate_required_extras(
            session, EntityType.CUSTOMER.value, extras, partial=True
        )
        _validate_extra_values(
            session,
            entity_type=EntityType.CUSTOMER.value,
            entity_id=customer.id,
            values=extras.items(),
        )

    before = customer.status
    customer.status = status
    customer.updated_by = actor
    session.flush()

    saved_extras: dict[str, Any] = {}
    if extras:
        saved_extras = set_extra_values(
            session,
            entity_type=EntityType.CUSTOMER.value,
            entity_id=customer.id,
            values=extras.items(),
        )

    record_audit(
        session,
        action=AuditAction.CUSTOMER_UPDATE,
        entity_type="customer",
        entity_id=customer.customer_no,
        actor=actor,
        before={"status": before},
        after={
            "status": status,
            **({"extra_values": saved_extras} if saved_extras else {}),
        },
    )
    return customer
