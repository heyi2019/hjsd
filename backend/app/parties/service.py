"""parties.service：客户、合作方、参与方校验、活字段的 Service 层。

规则来源：CUS-01、BAS-02-05、BAS-04、《ERP_接口错误码与状态机_v1.0.md》。

- 客户 `CUS0001` / 合作方 `CP0001` 编号域独立，创建后不可改、不可复用；
- 联系方式非唯一：重复只产生候选，**不拦截**；
- 停用 / 已合并对象不可作为新订单参与方（`CUSTOMER_DISABLED` / `COUNTERPARTY_DISABLED`）；
- 合并仅管理员：来源置 `MERGED`，迁移参与关系，保留原编号与审计。
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.security import CurrentUser, owner_scope_filter, owner_scope_ids
from app.core.numbering import allocate_number
from app.domain.enums import (
    AuditAction,
    CounterpartyStatus,
    CounterpartyType,
    CustomerStatus,
    EntityType,
    FieldType,
    SequenceKey,
)
from app.domain.parties import (
    Counterparty,
    Customer,
    EntityExtraValue,
    FieldDefinition,
    OrderCustomerRole,
)
from app.domain.users import User

FIELD_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
CONTACT_FIELDS: tuple[str, ...] = ("contact_name", "phone", "wechat", "qq", "note")


def _required_text(value: Any, *, message: str, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise Validation(message, details={"field": field})
    return value.strip()


def _normalize_extra_values(
    values: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if values is None:
        return {}
    if not isinstance(values, Mapping):
        raise Validation("活字段值必须为对象", details={"field": "extra_values"})
    normalized = dict(values)
    invalid_keys = [
        key for key in normalized if not isinstance(key, str) or not key.strip()
    ]
    if invalid_keys:
        raise Validation(
            "活字段键必须为非空字符串",
            details={"field": "extra_values"},
        )
    return normalized


def _validate_owner_id(session: Session, owner_id: int | None) -> None:
    if owner_id is None:
        return
    if isinstance(owner_id, bool) or not isinstance(owner_id, int) or owner_id <= 0:
        raise Validation(
            "客户负责人 ID 必须为正整数",
            details={"field": "owner_id", "value": owner_id},
        )
    if session.get(User, owner_id) is None:
        raise Validation(
            "客户负责人不存在",
            details={"field": "owner_id", "owner_id": owner_id},
        )


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


def to_customer_out(
    customer: Customer,
    *,
    reveal_contact: bool,
    extra_values: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
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
        "extra_values": dict(extra_values or {}),
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


def duplicate_candidates(
    session: Session,
    *,
    phone: str | None = None,
    wechat: str | None = None,
    qq: str | None = None,
    exclude_customer_id: int | None = None,
    user: CurrentUser | None = None,
) -> list[dict[str, Any]]:
    contacts: list[tuple[str, str, Any]] = []
    for label, value, column in (
        ("phone", phone, Customer.phone),
        ("wechat", wechat, Customer.wechat),
        ("qq", qq, Customer.qq),
    ):
        if value is None:
            continue
        if not isinstance(value, str):
            raise Validation(
                "联系方式必须为文本", details={"field": label}
            )
        normalized = value.strip()
        if normalized:
            contacts.append((label, normalized, column))
    conditions = [column == value for _label, value, column in contacts]
    if not conditions:
        return []

    stmt = select(Customer).where(or_(*conditions))
    if user is not None:
        scope = owner_scope_filter(Customer.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    rows = session.scalars(stmt).all()
    candidates: list[dict[str, Any]] = []
    for customer in rows:
        if exclude_customer_id is not None and customer.id == exclude_customer_id:
            continue
        matched = [
            label
            for label, value, _column in contacts
            if getattr(customer, label) == value
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
    session: Session, *, keyword: str | None = None, status: str | None = None,
    user: CurrentUser | None = None,
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
    if user is not None:
        scope = owner_scope_filter(Customer.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    return list(session.scalars(stmt.order_by(Customer.id)).all())


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

    if "owner_id" in fields and user is not None and not user.is_admin and user.owner_scope != "ALL":
        fields["owner_id"] = user.id
    if "owner_id" in fields:
        _validate_owner_id(session, fields["owner_id"])

    before = {name: getattr(customer, name) for name in CONTACT_FIELDS}
    allowed_fields = {
        "display_name", "contact_name", "phone", "wechat", "qq", "source",
        "owner_id", "tags", "note",
    }
    changed_contacts = False
    for name, value in fields.items():
        if name not in allowed_fields:
            raise Validation("客户更新字段不受支持", details={"field": name})
        if name == "display_name":
            if not isinstance(value, str) or not value.strip():
                raise Validation("称呼/昵称不能清空", details={"field": name})
            value = value.strip()
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
    user: CurrentUser | None = None,
) -> Customer:
    normalized_reason = _required_text(
        reason,
        field="reason",
        message="客户合并必须填写原因",
    )
    source = get_customer(session, source_customer_id, user)
    target = get_customer(session, target_customer_id, user)
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

    # 活字段是客户资料的一部分：目标已有同一字段时保留目标值，
    # 目标缺失时复制一份；来源行不删除，保证合并前的历史值仍可审计。
    source_extras = session.scalars(
        select(EntityExtraValue).where(
            EntityExtraValue.entity_type == EntityType.CUSTOMER.value,
            EntityExtraValue.entity_id == source.id,
        )
    ).all()
    target_extra_definition_ids = set(
        session.scalars(
            select(EntityExtraValue.field_definition_id).where(
                EntityExtraValue.entity_type == EntityType.CUSTOMER.value,
                EntityExtraValue.entity_id == target.id,
            )
        ).all()
    )
    migrated_extras = 0
    for extra in source_extras:
        if extra.field_definition_id in target_extra_definition_ids:
            continue
        session.add(
            EntityExtraValue(
                entity_type=extra.entity_type,
                entity_id=target.id,
                field_definition_id=extra.field_definition_id,
                value=dict(extra.value or {}),
            )
        )
        target_extra_definition_ids.add(extra.field_definition_id)
        migrated_extras += 1

    before = {"status": source.status, "merged_into_id": source.merged_into_id}
    source.status = CustomerStatus.MERGED.value
    source.merged_into_id = target.id
    source.merged_reason = normalized_reason
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
            "migrated_extra_values": migrated_extras,
        },
        reason=normalized_reason,
    )
    return target


def assert_customer_usable(
    session: Session, customer_id: int, *, user: CurrentUser | None = None
) -> Customer:
    """新订单参与方校验：停用/已合并一律拒绝（CUS-01-04、A11）。"""
    customer = get_customer(session, customer_id, user)
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
    source: str | None = None,
    note: str | None = None,
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
    allowed_fields = {
        "display_name", "contact_name", "phone", "wechat", "qq", "source", "note",
    }
    for name, value in fields.items():
        if name not in allowed_fields:
            raise Validation("合作方更新字段不受支持", details={"field": name})
        if name == "display_name":
            if not isinstance(value, str) or not value.strip():
                raise Validation("合作方名称不能清空", details={"field": name})
            value = value.strip()
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
def _normalize_field_options(
    field_type: str, options: Sequence[str] | None
) -> list[str]:
    """规范化字段选项，避免选择型字段退化成无约束文本。"""
    if options is None:
        raw: list[Any] = []
    elif isinstance(options, (str, bytes)):
        raise Validation("字段选项必须为字符串数组", details={"field": "options"})
    else:
        raw = list(options)

    if field_type not in (FieldType.SELECT.value, FieldType.MULTI_SELECT.value):
        if raw:
            raise Validation(
                "非选择型字段不能配置选项", details={"field": "options"}
            )
        return []

    normalized: list[str] = []
    for option in raw:
        if not isinstance(option, str) or not option.strip():
            raise Validation(
                "字段选项必须为非空字符串",
                details={"field": "options", "value": str(option)[:64]},
            )
        normalized.append(option.strip())
    if not normalized:
        raise Validation(
            "选择型字段至少需要一个选项", details={"field": "options"}
        )
    if len(set(normalized)) != len(normalized):
        raise Validation("字段选项不能重复", details={"field": "options"})
    return normalized


def _validate_extra_value(definition: FieldDefinition, value: Any) -> Any:
    """按字段类型校验活字段值；SELECT/MULTI_SELECT 必须在选项内（BAS-04）。"""
    if value is None:
        return None
    kind = definition.field_type
    if kind == "NUMBER":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise Validation(
                f"字段 {definition.label} 必须为数字",
                details={"field_key": definition.field_key, "value": str(value)[:64]},
            )
        return value
    if kind == "BOOLEAN":
        if not isinstance(value, bool):
            raise Validation(
                f"字段 {definition.label} 必须为布尔值",
                details={"field_key": definition.field_key},
            )
        return value
    if kind == "DATE":
        text = str(value).strip()
        try:
            date.fromisoformat(text)
        except ValueError as exc:
            raise Validation(
                f"字段 {definition.label} 必须为 YYYY-MM-DD 日期",
                details={"field_key": definition.field_key},
            ) from exc
        return text
    if kind == "SELECT":
        if not isinstance(value, str):
            raise Validation(
                f"字段 {definition.label} 必须为字符串",
                details={"field_key": definition.field_key},
            )
        options = list(definition.options or [])
        if not options:
            raise Validation(
                f"字段 {definition.label} 未配置有效选项",
                details={"field_key": definition.field_key},
            )
        if value not in options:
            raise Validation(
                f"字段 {definition.label} 的取值必须在选项内",
                details={"field_key": definition.field_key, "value": str(value)[:64]},
            )
        return value
    if kind == "MULTI_SELECT":
        if not isinstance(value, list):
            raise Validation(
                f"字段 {definition.label} 必须为数组",
                details={"field_key": definition.field_key},
            )
        if any(not isinstance(item, str) for item in value):
            raise Validation(
                f"字段 {definition.label} 的选项必须为字符串",
                details={"field_key": definition.field_key},
            )
        options = list(definition.options or [])
        if not options:
            raise Validation(
                f"字段 {definition.label} 未配置有效选项",
                details={"field_key": definition.field_key},
            )
        if len(set(value)) != len(value) or any(item not in options for item in value):
            raise Validation(
                f"字段 {definition.label} 的取值必须在选项内",
                details={"field_key": definition.field_key},
            )
        return value
    if kind == "TEXT":
        if not isinstance(value, str):
            raise Validation(
                f"字段 {definition.label} 必须为字符串",
                details={"field_key": definition.field_key},
            )
        return value
    return str(value)


def _validate_extra_values(
    session: Session,
    *,
    entity_type: str,
    entity_id: int | None,
    values: Iterable[tuple[str, Any]],
) -> list[tuple[str, FieldDefinition, Any]]:
    if (
        entity_type == EntityType.CUSTOMER.value
        and entity_id is not None
        and session.get(Customer, entity_id) is None
    ):
        raise NotFound(
            f"客户 {entity_id} 不存在",
            details={"entity_type": entity_type, "entity_id": entity_id},
        )

    validated: list[tuple[str, FieldDefinition, Any]] = []
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
        validated.append(
            (field_key, definition, _validate_extra_value(definition, value))
        )
    return validated


def _validate_required_extras(
    session: Session, entity_type: str, values: Mapping[str, Any], *, partial: bool = False
) -> None:
    """必填活字段缺失即拒绝（BAS-04-04）。

    partial=True（更新路径）：只校验**本次提交**涉及到的必填字段非空，
    不要求把历史上已填过的必填字段再交一遍。
    """
    definitions = session.scalars(
        select(FieldDefinition).where(
            FieldDefinition.entity_type == entity_type,
            FieldDefinition.required.is_(True),
            FieldDefinition.is_active.is_(True),
        )
    ).all()
    if partial:
        missing = [
            definition.field_key
            for definition in definitions
            if definition.field_key in values and values.get(definition.field_key) in (None, "")
        ]
    else:
        missing = [
            definition.field_key
            for definition in definitions
            if values.get(definition.field_key) in (None, "")
        ]
    if missing:
        raise Validation(
            f"必填活字段未填写：{', '.join(missing)}",
            details={"fields": missing},
        )


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
    entity = _required_text(
        entity_type, message=f"实体类型必须为 {EntityType.values()}", field="entity_type"
    ).lower()
    if entity not in EntityType.values():
        raise Validation(
            f"实体类型必须为 {EntityType.values()}",
            details={"field": "entity_type", "value": entity_type},
        )
    if not isinstance(field_type, str) or field_type not in FieldType.values():
        raise Validation(
            f"字段类型必须为 {FieldType.values()}",
            details={"field": "field_type", "value": field_type},
        )
    if isinstance(sort_order, bool) or not isinstance(sort_order, int):
        raise Validation(
            "排序值必须为整数",
            details={"field": "sort_order", "value": sort_order},
        )
    if sort_order < 0:
        raise Validation(
            "排序值不能为负数",
            details={"field": "sort_order", "value": sort_order},
        )
    normalized_options = _normalize_field_options(field_type, options)
    key = _required_text(
        field_key,
        message="字段键必须为小写字母开头，仅含小写字母、数字与下划线",
        field="field_key",
    )
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

    normalized_label = _required_text(
        label, message="字段名称不能为空", field="label"
    )

    definition = FieldDefinition(
        entity_type=entity,
        field_key=key,
        label=normalized_label,
        field_type=field_type,
        options=normalized_options,
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
    validated = _validate_extra_values(
        session,
        entity_type=entity_type,
        entity_id=entity_id,
        values=values,
    )

    saved: dict[str, Any] = {}
    for field_key, definition, normalized_value in validated:
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
                value={"value": normalized_value},
            )
            session.add(row)
        else:
            row.value = {"value": normalized_value}
        saved[field_key] = normalized_value
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


def get_extra_values_bulk(
    session: Session, *, entity_type: str, entity_ids: Iterable[int]
) -> dict[int, dict[str, Any]]:
    """批量读取活字段值：列表页一次查询，避免逐行 N+1。"""
    ids = list(entity_ids)
    result: dict[int, dict[str, Any]] = {entity_id: {} for entity_id in ids}
    if not ids:
        return result
    rows = session.scalars(
        select(EntityExtraValue).where(
            EntityExtraValue.entity_type == entity_type,
            EntityExtraValue.entity_id.in_(ids),
        )
    ).all()
    if not rows:
        return result
    definitions = session.scalars(
        select(FieldDefinition).where(
            FieldDefinition.id.in_({row.field_definition_id for row in rows})
        )
    ).all()
    key_by_id = {definition.id: definition.field_key for definition in definitions}
    for row in rows:
        field_key = key_by_id.get(row.field_definition_id)
        if field_key is not None:
            result.setdefault(row.entity_id, {})[field_key] = (row.value or {}).get("value")
    return result


def delete_field_definition(
    session: Session, definition_id: int, *, actor: str
) -> None:
    """删除字段定义：无历史值才可物理删除；有值只能停用（BAS-04-03）。"""
    definition = session.get(FieldDefinition, definition_id)
    if definition is None:
        raise NotFound(
            f"字段定义 {definition_id} 不存在", details={"field_definition_id": definition_id}
        )
    used = session.scalar(
        select(func.count())
        .select_from(EntityExtraValue)
        .where(EntityExtraValue.field_definition_id == definition_id)
    )
    if used:
        raise Conflict(
            f"字段 {definition.label} 已有 {used} 条历史值，只能停用不能删除",
            code=ErrorCode.FIELD_DEFINITION_HAS_VALUES,
            details={
                "field_key": definition.field_key,
                "value_count": int(used),
            },
        )
    record_audit(
        session,
        action=AuditAction.FIELD_DEFINITION_CHANGE,
        entity_type="field_definition",
        entity_id=f"{definition.entity_type}.{definition.field_key}",
        actor=actor,
        before={"label": definition.label, "is_active": definition.is_active},
        after={"deleted": True},
    )
    session.delete(definition)
    session.flush()


__all__ = [
    "assert_counterparty_usable",
    "assert_customer_usable",
    "create_counterparty",
    "create_customer",
    "create_field_definition",
    "delete_field_definition",
    "duplicate_candidates",
    "get_counterparty",
    "get_customer",
    "get_extra_values",
    "get_extra_values_bulk",
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
