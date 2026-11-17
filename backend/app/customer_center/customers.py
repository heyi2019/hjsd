"""parties.customers：客户档案的建档、查询、变更、合并与参与方校验。

规则来源：CUS-01。

- 客户 `CUS0001` 编号域独立，创建后不可改、不可复用；
- 联系方式非唯一：重复只产生候选，**不拦截**；
- 停用 / 已合并对象不可作为新订单参与方（`CUSTOMER_DISABLED`）；
- 合并仅管理员：来源置 `MERGED`，迁移参与关系，保留原编号与审计。"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date, datetime, time, timedelta
from typing import Any

from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.like_pattern import like_contains
from app.shared.numbering import allocate_number
from app.core.security import CurrentUser
from app.shared.scope import owner_scope_filter, owner_scope_ids
from app.domain.enums import AuditAction, CustomerStatus, EntityType, SequenceKey
from app.domain.parties import Customer

from ._common import (
    CONTACT_FIELDS,
    _normalize_extra_values,
    _required_text,
    _validate_owner_id,
)
from app.shared.form_values import _validate_extra_values, _validate_required_extras, set_extra_values

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
    _validate_required_extras(session, EntityType.CUSTOMER.value, extras)
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


def list_customers(
    session: Session, *, keyword: str | None = None, status: str | None = None,
    created_by: Sequence[str] | None = None, user: CurrentUser | None = None,
    limit: int | None = None, offset: int = 0,
) -> list[Customer]:
    stmt = _customer_list_stmt(
        keyword=keyword, status=status, created_by=created_by, user=user, session=session
    )
    if limit is not None:
        stmt = stmt.limit(limit).offset(offset)
    return list(session.scalars(stmt.order_by(Customer.id)).all())


def count_customers(
    session: Session, *, keyword: str | None = None, status: str | None = None,
    created_by: Sequence[str] | None = None, user: CurrentUser | None = None,
) -> int:
    stmt = _customer_list_stmt(
        keyword=keyword, status=status, created_by=created_by, user=user, session=session
    )
    return int(session.scalar(select(func.count()).select_from(stmt.subquery())) or 0)


def summarize_customers(
    session: Session,
    *,
    today_date: date,
    keyword: str | None = None,
    status: str | None = None,
    created_by: Sequence[str] | None = None,
    user: CurrentUser | None = None,
) -> dict[str, int]:
    """Summarize the same customer scope as the list, using the caller's local date."""
    month_start = today_date.replace(day=1)
    today_start = datetime.combine(today_date, time.min)
    tomorrow_start = datetime.combine(today_date + timedelta(days=1), time.min)
    month_start_at = datetime.combine(month_start, time.min)

    scope = _customer_list_stmt(
        keyword=keyword, status=status, created_by=created_by, user=user, session=session
    ).subquery()
    created_at = scope.c.created_at
    month_count, today_count = session.execute(
        select(
            func.coalesce(
                func.sum(
                    case(
                        (
                            (created_at >= month_start_at)
                            & (created_at < tomorrow_start),
                            1,
                        ),
                        else_=0,
                    )
                ),
                0,
            ),
            func.coalesce(
                func.sum(
                    case(
                        (
                            (created_at >= today_start)
                            & (created_at < tomorrow_start),
                            1,
                        ),
                        else_=0,
                    )
                ),
                0,
            ),
        ).select_from(scope)
    ).one()

    return {
        "month_count": int(month_count),
        "today_count": int(today_count),
    }


def _customer_list_stmt(
    *, keyword: str | None, status: str | None, created_by: Sequence[str] | None,
    user: CurrentUser | None, session: Session
):
    stmt = select(Customer)
    if status:
        stmt = stmt.where(Customer.status == status)
    if created_by:
        stmt = stmt.where(Customer.created_by.in_(created_by))
    if keyword:
        pattern, escape = like_contains(keyword)
        stmt = stmt.where(
            or_(
                Customer.display_name.like(pattern, escape=escape),
                Customer.customer_no.like(pattern, escape=escape),
                Customer.phone.like(pattern, escape=escape),
                Customer.wechat.like(pattern, escape=escape),
                Customer.qq.like(pattern, escape=escape),
            )
        )
    if user is not None:
        scope = owner_scope_filter(Customer.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    return stmt


def get_customer(session: Session, customer_id: int, user: CurrentUser | None = None) -> Customer:
    customer = session.get(Customer, customer_id)
    if customer is None:
        raise NotFound(f"客户 {customer_id} 不存在", details={"customer_id": customer_id})
    if user is not None and user.owner_scope != "ALL" and not user.is_admin:
        visible_ids = owner_scope_ids(session, user)
        if customer.owner_id not in (visible_ids or set()):
            raise NotFound(f"客户 {customer_id} 不存在", details={"customer_id": customer_id})
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
        _validate_required_extras(
            session, EntityType.CUSTOMER.value, extras, partial=True
        )
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

__all__ = [
    "create_customer",
    "list_customers",
    "count_customers",
    "_customer_list_stmt",
    "get_customer",
    "update_customer",
    "set_customer_status",
]
