"""customer_center.counterparties：合作方档案与合作方参与方校验。

规则来源：BAS-02-05。停用后不可参与新订单，历史参与关系不物理删除。
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import ErrorCode, NotFound, Validation
from app.shared.numbering import allocate_number
from app.domain.enums import (
    AuditAction,
    CounterpartyStatus,
    CounterpartyType,
    EntityType,
    SequenceKey,
)
from app.domain.parties import Counterparty

from ._common import (
    _UNSET,
    _normalize_extra_values,
    _required_bool,
    _required_text,
)
from app.shared.form_values import _validate_required_extras, set_extra_values

# --------------------------------------------------------------------- 合作方
def create_counterparty(
    session: Session,
    *,
    display_name: str,
    type: str,
    actor: str,
    contact_name: str | None = None,
    phone: str | None = None,
    wechat: str | None = None,
    qq: str | None = None,
    source: str | None = None,
    note: str | None = None,
    extra_values: Mapping[str, Any] | None = None,
) -> Counterparty:
    name = _required_text(
        display_name, message="合作方名称必填", field="display_name"
    )
    try:
        CounterpartyType(type)
    except ValueError as exc:
        raise Validation(
            f"合作方类型必须为 {CounterpartyType.values()}",
            details={"field": "type", "value": type},
        ) from exc

    counterparty = Counterparty(
        counterparty_no=allocate_number(session, SequenceKey.COUNTERPARTY),
        display_name=name,
        type=type,
        contact_name=contact_name,
        phone=phone,
        wechat=wechat,
        qq=qq,
        source=source,
        note=note,
        status=CounterpartyStatus.ACTIVE.value,
        created_by=actor,
        updated_by=actor,
    )
    session.add(counterparty)
    session.flush()
    set_extra_values(
        session,
        entity_type=EntityType.COUNTERPARTY.value,
        entity_id=counterparty.id,
        values=(extra_values or {}).items(),
        require_all=True,
    )
    record_audit(
        session,
        action=AuditAction.CUSTOMER_CREATE,
        entity_type="counterparty",
        entity_id=counterparty.counterparty_no,
        actor=actor,
        after={"display_name": name, "type": type},
    )
    return counterparty


def list_counterparties(
    session: Session,
    *,
    type: str | None = None,
    status: str | None = None,
    created_by: Sequence[str] | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> list[Counterparty]:
    stmt = select(Counterparty)
    if type:
        stmt = stmt.where(Counterparty.type == type)
    if status:
        stmt = stmt.where(Counterparty.status == status)
    if created_by:
        stmt = stmt.where(Counterparty.created_by.in_(created_by))
    if limit is not None:
        stmt = stmt.limit(limit).offset(offset)
    return list(session.scalars(stmt.order_by(Counterparty.id)).all())


def count_counterparties(
    session: Session, *, type: str | None = None, status: str | None = None,
    created_by: Sequence[str] | None = None,
) -> int:
    stmt = select(func.count(Counterparty.id))
    if type:
        stmt = stmt.where(Counterparty.type == type)
    if status:
        stmt = stmt.where(Counterparty.status == status)
    if created_by:
        stmt = stmt.where(Counterparty.created_by.in_(created_by))
    return int(session.scalar(stmt) or 0)


def get_counterparty(session: Session, counterparty_id: int) -> Counterparty:
    item = session.get(Counterparty, counterparty_id)
    if item is None:
        raise NotFound(
            f"合作方 {counterparty_id} 不存在", details={"counterparty_id": counterparty_id}
        )
    return item


def update_counterparty(
    session: Session,
    counterparty_id: int,
    *,
    actor: str,
    extra_values: Mapping[str, Any] | None | object = _UNSET,
    **fields: Any,
) -> Counterparty:
    item = get_counterparty(session, counterparty_id)
    allowed_fields = {
        "display_name", "contact_name", "phone", "wechat", "qq", "source", "note",
    }
    for name in fields:
        if name not in allowed_fields:
            raise Validation("合作方更新字段不受支持", details={"field": name})

    normalized_fields: dict[str, Any] = {}
    for name, value in fields.items():
        if name == "display_name":
            if not isinstance(value, str) or not value.strip():
                raise Validation("合作方名称不能清空", details={"field": name})
            value = value.strip()
        normalized_fields[name] = value
    for name, value in normalized_fields.items():
        setattr(item, name, value)
    item.updated_by = actor
    session.flush()
    if extra_values is not _UNSET:
        values = _normalize_extra_values(extra_values)
        _validate_required_extras(
            session, EntityType.COUNTERPARTY.value, values, partial=True
        )
        set_extra_values(
            session,
            entity_type=EntityType.COUNTERPARTY.value,
            entity_id=item.id,
            values=values.items(),
        )
    record_audit(
        session,
        action=AuditAction.CUSTOMER_UPDATE,
        entity_type="counterparty",
        entity_id=item.counterparty_no,
        actor=actor,
        after={"display_name": item.display_name, "status": item.status},
    )
    return item


def set_counterparty_status(
    session: Session, counterparty_id: int, active: bool, *, actor: str
) -> Counterparty:
    """停用后不可参与新订单；有历史参与关系不物理删除（BAS-02-05）。"""
    active = _required_bool(active, field="active")
    item = get_counterparty(session, counterparty_id)
    before = item.status
    item.status = (
        CounterpartyStatus.ACTIVE.value if active else CounterpartyStatus.DISABLED.value
    )
    item.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.CUSTOMER_UPDATE,
        entity_type="counterparty",
        entity_id=item.counterparty_no,
        actor=actor,
        before={"status": before},
        after={"status": item.status},
    )
    return item


def assert_counterparty_usable(
    session: Session, counterparty_id: int, *, expected_type: str | None = None
) -> Counterparty:
    item = get_counterparty(session, counterparty_id)
    if item.status != CounterpartyStatus.ACTIVE.value:
        raise Validation(
            f"合作方 {item.counterparty_no} 已停用，不可作为新订单参与方",
            code=ErrorCode.COUNTERPARTY_DISABLED,
            details={"counterparty_no": item.counterparty_no, "status": item.status},
        )
    if expected_type and item.type != expected_type:
        raise Validation(
            f"合作方类型应为 {expected_type}，实际为 {item.type}",
            code=ErrorCode.PARTICIPANT_ROLE_INVALID,
            details={"counterparty_no": item.counterparty_no, "type": item.type},
        )
    return item
