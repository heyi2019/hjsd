"""parties.service：客户、合作方、参与方校验、活字段的 Service 层。

规则来源：CUS-01、BAS-02-05、BAS-04、《ERP_接口错误码与状态机_v1.0.md》。

- 客户 `CUS0001` / 合作方 `CP0001` 编号域独立，创建后不可改、不可复用；
- 联系方式非唯一：重复只产生候选，**不拦截**；
- 停用 / 已合并对象不可作为新订单参与方（`CUSTOMER_DISABLED` / `COUNTERPARTY_DISABLED`）；
- 合并仅管理员：来源置 `MERGED`，迁移参与关系，保留原编号与审计。
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.numbering import allocate_number
from app.domain.enums import (
    AuditAction,
    CounterpartyStatus,
    CounterpartyType,
    CustomerStatus,
    EntityType,
    SequenceKey,
)
from app.domain.parties import (
    Counterparty,
    Customer,
    EntityExtraValue,
    FieldDefinition,
    OrderCustomerRole,
)

FIELD_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
CONTACT_FIELDS: tuple[str, ...] = ("contact_name", "phone", "wechat", "qq", "note")


# --------------------------------------------------------------------- 脱敏
def mask_phone(value: str | None) -> str | None:
    if not value:
        return value
    digits = value.strip()
    if len(digits) <= 7:
        return digits[:3] + "*" * max(len(digits) - 3, 0)
    return f"{digits[:3]}****{digits[-4:]}"


def mask_id(value: str | None) -> str | None:
    """微信号 / QQ 局部遮罩（权限矩阵 §3）。"""
    if not value:
        return value
    text = value.strip()
    if len(text) <= 2:
        return text[0] + "*" * (len(text) - 1)
    head = text[:2]
    return head + "*" * (len(text) - 2)


def to_customer_out(customer: Customer, *, reveal_contact: bool) -> dict[str, Any]:
    payload = {
        "id": customer.id,
        "customer_no": customer.customer_no,
        "display_name": customer.display_name,
        "contact_name": customer.contact_name,
        "phone": customer.phone,
        "wechat": customer.wechat,
        "qq": customer.qq,
        "source": customer.source,
        "owner_id": customer.owner_id,
        "status": customer.status,
        "tags": customer.tags,
        "note": customer.note,
        "merged_into_id": customer.merged_into_id,
        "contact_masked": False,
    }
    if reveal_contact:
        return payload
    payload["phone"] = mask_phone(customer.phone)
    payload["wechat"] = mask_id(customer.wechat)
    payload["qq"] = mask_id(customer.qq)
    payload["contact_masked"] = True
    return payload


# --------------------------------------------------------------------- 客户
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
) -> Customer:
    name = (display_name or "").strip()
    if not name:
        raise Validation("称呼/昵称必填", details={"field": "display_name"})

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
    record_audit(
        session,
        action=AuditAction.CUSTOMER_CREATE,
        entity_type="customer",
        entity_id=customer.customer_no,
        actor=actor,
        after={"display_name": name, "status": customer.status},
    )
    return customer


def duplicate_candidates(
    session: Session,
    *,
    phone: str | None = None,
    wechat: str | None = None,
    qq: str | None = None,
    exclude_customer_id: int | None = None,
) -> list[dict[str, Any]]:
    conditions = []
    for value, column in ((phone, Customer.phone), (wechat, Customer.wechat), (qq, Customer.qq)):
        if value:
            conditions.append(column == value.strip())
    if not conditions:
        return []

    rows = session.scalars(select(Customer).where(or_(*conditions))).all()
    candidates: list[dict[str, Any]] = []
    for customer in rows:
        if exclude_customer_id is not None and customer.id == exclude_customer_id:
            continue
        matched = [
            label
            for label, value in (("phone", phone), ("wechat", wechat), ("qq", qq))
            if value and getattr(customer, label) == value.strip()
        ]
        if matched:
            candidates.append(
                {
                    "customer_id": customer.id,
                    "customer_no": customer.customer_no,
                    "display_name": customer.display_name,
                    "matched_on": matched,
                }
            )
    return candidates


def list_customers(
    session: Session, *, keyword: str | None = None, status: str | None = None
) -> list[Customer]:
    stmt = select(Customer)
    if status:
        stmt = stmt.where(Customer.status == status)
    if keyword:
        pattern = f"%{keyword.strip()}%"
        stmt = stmt.where(
            or_(
                Customer.display_name.like(pattern),
                Customer.customer_no.like(pattern),
                Customer.phone.like(pattern),
                Customer.wechat.like(pattern),
                Customer.qq.like(pattern),
            )
        )
    return list(session.scalars(stmt.order_by(Customer.id)).all())


def get_customer(session: Session, customer_id: int) -> Customer:
    customer = session.get(Customer, customer_id)
    if customer is None:
        raise NotFound(f"客户 {customer_id} 不存在", details={"customer_id": customer_id})
    return customer


def update_customer(
    session: Session, customer_id: int, *, actor: str, **fields: Any
) -> Customer:
    customer = get_customer(session, customer_id)
    if customer.status == CustomerStatus.MERGED.value:
        raise Conflict(
            "已合并客户不可修改",
            code=ErrorCode.MERGE_TARGET_INVALID,
            details={"customer_no": customer.customer_no},
        )

    before = {name: getattr(customer, name) for name in CONTACT_FIELDS}
    changed_contacts = False
    for name, value in fields.items():
        if value is None:
            continue
        if getattr(customer, name, None) != value:
            setattr(customer, name, value)
            if name in CONTACT_FIELDS:
                changed_contacts = True
    customer.updated_by = actor
    session.flush()

    action = AuditAction.CONTACT_WRITE if changed_contacts else AuditAction.CUSTOMER_UPDATE
    record_audit(
        session,
        action=action,
        entity_type="customer",
        entity_id=customer.customer_no,
        actor=actor,
        before=before,
        after={name: getattr(customer, name) for name in CONTACT_FIELDS},
    )
    return customer


def set_customer_status(
    session: Session, customer_id: int, status: str, *, actor: str
) -> Customer:
    customer = get_customer(session, customer_id)
    if status == CustomerStatus.MERGED.value:
        raise Validation(
            "MERGED 只能由合并动作产生", details={"field": "status", "value": status}
        )
    before = customer.status
    customer.status = status
    customer.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.CUSTOMER_UPDATE,
        entity_type="customer",
        entity_id=customer.customer_no,
        actor=actor,
        before={"status": before},
        after={"status": status},
    )
    return customer


def merge_customers(
    session: Session,
    *,
    source_customer_id: int,
    target_customer_id: int,
    reason: str,
    actor: str,
) -> Customer:
    source = get_customer(session, source_customer_id)
    target = get_customer(session, target_customer_id)
    if source.id == target.id:
        raise Validation("来源与目标不能是同一客户", code=ErrorCode.MERGE_TARGET_INVALID)
    if target.status != CustomerStatus.ACTIVE.value:
        raise Validation(
            "目标客户必须为 ACTIVE",
            code=ErrorCode.MERGE_TARGET_INVALID,
            details={"target_customer_no": target.customer_no, "status": target.status},
        )
    if source.status == CustomerStatus.MERGED.value:
        raise Validation(
            "来源客户已合并",
            code=ErrorCode.MERGE_TARGET_INVALID,
            details={"source_customer_no": source.customer_no},
        )

    # 迁移参与关系：目标已有同订单同角色则跳过（UNIQUE(order, customer, role)）
    roles = session.scalars(
        select(OrderCustomerRole).where(OrderCustomerRole.customer_id == source.id)
    ).all()
    migrated = 0
    for role in roles:
        exists = session.scalar(
            select(OrderCustomerRole).where(
                OrderCustomerRole.order_id == role.order_id,
                OrderCustomerRole.customer_id == target.id,
                OrderCustomerRole.role == role.role,
            )
        )
        if exists is not None:
            session.delete(role)
            continue
        role.customer_id = target.id
        migrated += 1

    before = {"status": source.status, "merged_into_id": source.merged_into_id}
    source.status = CustomerStatus.MERGED.value
    source.merged_into_id = target.id
    source.merged_reason = reason
    source.updated_by = actor
    session.flush()

    record_audit(
        session,
        action=AuditAction.CUSTOMER_MERGE,
        entity_type="customer",
        entity_id=source.customer_no,
        actor=actor,
        before=before,
        after={
            "status": source.status,
            "merged_into": target.customer_no,
            "migrated_roles": migrated,
        },
        reason=reason,
    )
    return target


def assert_customer_usable(session: Session, customer_id: int) -> Customer:
    """新订单参与方校验：停用/已合并一律拒绝（CUS-01-04、A11）。"""
    customer = get_customer(session, customer_id)
    if customer.status != CustomerStatus.ACTIVE.value:
        raise Validation(
            f"客户 {customer.customer_no} 状态为 {customer.status}，不可作为新订单参与方",
            code=ErrorCode.CUSTOMER_DISABLED,
            details={"customer_no": customer.customer_no, "status": customer.status},
        )
    return customer


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
    note: str | None = None,
) -> Counterparty:
    name = (display_name or "").strip()
    if not name:
        raise Validation("合作方名称必填", details={"field": "display_name"})
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
        note=note,
        status=CounterpartyStatus.ACTIVE.value,
        created_by=actor,
        updated_by=actor,
    )
    session.add(counterparty)
    session.flush()
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
    session: Session, *, type: str | None = None, status: str | None = None
) -> list[Counterparty]:
    stmt = select(Counterparty)
    if type:
        stmt = stmt.where(Counterparty.type == type)
    if status:
        stmt = stmt.where(Counterparty.status == status)
    return list(session.scalars(stmt.order_by(Counterparty.id)).all())


def get_counterparty(session: Session, counterparty_id: int) -> Counterparty:
    item = session.get(Counterparty, counterparty_id)
    if item is None:
        raise NotFound(
            f"合作方 {counterparty_id} 不存在", details={"counterparty_id": counterparty_id}
        )
    return item


def update_counterparty(
    session: Session, counterparty_id: int, *, actor: str, **fields: Any
) -> Counterparty:
    item = get_counterparty(session, counterparty_id)
    for name, value in fields.items():
        if value is not None:
            setattr(item, name, value)
    item.updated_by = actor
    session.flush()
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


# --------------------------------------------------------------------- 活字段
def create_field_definition(
    session: Session,
    *,
    entity_type: str,
    field_key: str,
    label: str,
    actor: str,
    field_type: str = "TEXT",
    options: Sequence[str] | None = None,
    required: bool = False,
    sort_order: int = 0,
) -> FieldDefinition:
    entity = (entity_type or "").strip().lower()
    if entity not in EntityType.values():
        raise Validation(
            f"实体类型必须为 {EntityType.values()}",
            details={"field": "entity_type", "value": entity_type},
        )
    key = (field_key or "").strip()
    if not FIELD_KEY_PATTERN.match(key):
        raise Validation(
            "字段键必须为小写字母开头，仅含小写字母、数字与下划线",
            details={"field": "field_key", "value": field_key},
        )
    exists = session.scalar(
        select(FieldDefinition).where(
            FieldDefinition.entity_type == entity, FieldDefinition.field_key == key
        )
    )
    if exists is not None:
        raise Conflict(
            f"字段 {key} 已存在",
            code=ErrorCode.DUPLICATE_CODE,
            details={"entity_type": entity, "field_key": key},
        )

    definition = FieldDefinition(
        entity_type=entity,
        field_key=key,
        label=label.strip(),
        field_type=field_type,
        options=list(options or []),
        required=required,
        sort_order=sort_order,
        is_active=True,
        created_by=actor,
        updated_by=actor,
    )
    session.add(definition)
    session.flush()
    record_audit(
        session,
        action=AuditAction.FIELD_DEFINITION_CHANGE,
        entity_type="field_definition",
        entity_id=f"{entity}.{key}",
        actor=actor,
        after={"label": label, "is_active": True},
    )
    return definition


def list_field_definitions(
    session: Session, *, entity_type: str | None = None, include_inactive: bool = True
) -> list[FieldDefinition]:
    stmt = select(FieldDefinition)
    if entity_type:
        stmt = stmt.where(FieldDefinition.entity_type == entity_type)
    if not include_inactive:
        stmt = stmt.where(FieldDefinition.is_active.is_(True))
    return list(session.scalars(stmt.order_by(FieldDefinition.sort_order, FieldDefinition.id)))


def set_field_definition_active(
    session: Session, definition_id: int, active: bool, *, actor: str
) -> FieldDefinition:
    """停用后历史值仍显示，新建表单不可填（A10）。"""
    definition = session.get(FieldDefinition, definition_id)
    if definition is None:
        raise NotFound(
            f"字段定义 {definition_id} 不存在", details={"field_definition_id": definition_id}
        )
    before = definition.is_active
    definition.is_active = active
    definition.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.FIELD_DEFINITION_CHANGE,
        entity_type="field_definition",
        entity_id=f"{definition.entity_type}.{definition.field_key}",
        actor=actor,
        before={"is_active": before},
        after={"is_active": active},
    )
    return definition


def set_extra_values(
    session: Session,
    *,
    entity_type: str,
    entity_id: int,
    values: Iterable[tuple[str, Any]],
) -> dict[str, Any]:
    """按启用的字段定义写入活字段值；未启用字段拒绝写入（BAS-04-04）。"""
    saved: dict[str, Any] = {}
    for field_key, value in values:
        definition = session.scalar(
            select(FieldDefinition).where(
                FieldDefinition.entity_type == entity_type,
                FieldDefinition.field_key == field_key,
                FieldDefinition.is_active.is_(True),
            )
        )
        if definition is None:
            raise Validation(
                f"字段 {field_key} 未启用或不存在",
                details={"entity_type": entity_type, "field_key": field_key},
            )
        row = session.scalar(
            select(EntityExtraValue).where(
                EntityExtraValue.entity_type == entity_type,
                EntityExtraValue.entity_id == entity_id,
                EntityExtraValue.field_definition_id == definition.id,
            )
        )
        if row is None:
            row = EntityExtraValue(
                entity_type=entity_type,
                entity_id=entity_id,
                field_definition_id=definition.id,
                value={"value": value},
            )
            session.add(row)
        else:
            row.value = {"value": value}
        saved[field_key] = value
    session.flush()
    return saved


def get_extra_values(session: Session, *, entity_type: str, entity_id: int) -> dict[str, Any]:
    rows = session.scalars(
        select(EntityExtraValue).where(
            EntityExtraValue.entity_type == entity_type,
            EntityExtraValue.entity_id == entity_id,
        )
    ).all()
    result: dict[str, Any] = {}
    for row in rows:
        definition = session.get(FieldDefinition, row.field_definition_id)
        if definition is not None:
            result[definition.field_key] = (row.value or {}).get("value")
    return result


__all__ = [
    "assert_counterparty_usable",
    "assert_customer_usable",
    "create_counterparty",
    "create_customer",
    "create_field_definition",
    "duplicate_candidates",
    "get_counterparty",
    "get_customer",
    "get_extra_values",
    "list_counterparties",
    "list_customers",
    "list_field_definitions",
    "mask_id",
    "mask_phone",
    "merge_customers",
    "set_counterparty_status",
    "set_customer_status",
    "set_extra_values",
    "set_field_definition_active",
    "to_customer_out",
    "update_counterparty",
    "update_customer",
]
