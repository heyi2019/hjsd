"""parties 领域共用的字段规则、实体映射和客户输出转换。"""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from sqlalchemy import inspect
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.domain.enums import EntityType
from app.domain.parties import (
    Counterparty,
    Customer,
    CustomerLead,
)
from app.domain.foundation import Pool
from app.domain.trade import Account, Cashflow, Installment, Order
from app.domain.users import User

FIELD_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
ORDER_TYPE_CODE_PATTERN = re.compile(r"^[A-Z0-9]{2,10}$")
CONTACT_FIELDS: tuple[str, ...] = ("contact_name", "phone", "wechat", "qq", "note")
_UNSET = object()

_EXTRA_ENTITY_MODELS: dict[str, type] = {
    EntityType.ORDER.value: Order,
    EntityType.ACCOUNT.value: Account,
    EntityType.CUSTOMER.value: Customer,
    EntityType.INSTALLMENT.value: Installment,
    EntityType.POOL.value: Pool,
    EntityType.CASHFLOW.value: Cashflow,
    EntityType.LEAD.value: CustomerLead,
    EntityType.COUNTERPARTY.value: Counterparty,
}

# These fields are assembled by routers rather than persisted on the entity
# row.  A live field with one of these keys would be silently overwritten in
# the response, so it is reserved just like a real model column.
_FIXED_OUTPUT_FIELDS: dict[str, set[str]] = {
    EntityType.ORDER.value: {
        "events",
        "links",
        "cashflows",
        "rebates",
        "installment",
        "installment_schedule",
        "audit",
        "attachments",
        "account_game_type",
        "account_game_account",
        "account_channel_region",
        "account_business_mode",
        "account_platform",
        "account_status",
        "party_name",
        "party_role",
        "party_source",
        "party_created_by",
        "party_created_at",
        "event_total",
        "last_event_type",
        "last_event_amount",
        "last_event_on",
        "installment_principal",
        "installment_paid",
        "installment_periods",
        "installment_status",
    },
    EntityType.ACCOUNT.value: {"source_order_no"},
    EntityType.CUSTOMER.value: {
        "contact_masked",
        "order_roles",
        "active_order_count",
        "last_interaction_at",
    },
    EntityType.CASHFLOW.value: {"order_no", "source", "occurred_at", "operator"},
}


def _fixed_entity_fields(entity_type: str) -> set[str]:
    """Return persisted/API-reserved names that a live field cannot shadow."""
    model = _EXTRA_ENTITY_MODELS[entity_type]
    return (
        {column.key for column in inspect(model).mapper.column_attrs}
        | {"extra_values"}
        | _FIXED_OUTPUT_FIELDS.get(entity_type, set())
    )


def _required_text(value: Any, *, message: str, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise Validation(message, details={"field": field})
    return value.strip()


def _required_bool(value: object, *, field: str) -> bool:
    if not isinstance(value, bool):
        raise Validation(f"{field} 必须为布尔值", details={"field": field})
    return value


def _normalize_extra_values(
    values: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if values is None:
        return {}
    if not isinstance(values, Mapping):
        raise Validation("表单扩展字段值必须为对象", details={"field": "extra_values"})
    normalized = dict(values)
    invalid_keys = [
        key for key in normalized if not isinstance(key, str) or not key.strip()
    ]
    if invalid_keys:
        raise Validation(
            "表单扩展字段键必须为非空字符串",
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
    owner = session.get(User, owner_id)
    if owner is None:
        raise Validation(
            "客户负责人不存在",
            details={"field": "owner_id", "owner_id": owner_id},
        )
    if not owner.is_active:
        raise Validation(
            "客户负责人必须是启用用户",
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
    activity_summary: Mapping[str, Any] | None = None,
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
        "created_at": customer.created_at,
        "tags": customer.tags,
        "note": customer.note,
        "merged_into_id": customer.merged_into_id,
        "contact_masked": False,
        "extra_values": dict(extra_values or {}),
        "order_roles": list((activity_summary or {}).get("order_roles", [])),
        "active_order_count": int((activity_summary or {}).get("active_order_count", 0)),
        "last_interaction_at": (activity_summary or {}).get("last_interaction_at"),
    }
    if reveal_contact:
        return payload
    payload["phone"] = mask_phone(customer.phone)
    payload["wechat"] = mask_id(customer.wechat)
    payload["qq"] = mask_id(customer.qq)
    payload["contact_masked"] = True
    return payload


def to_counterparty_out(
    counterparty: Counterparty,
    *,
    reveal_contact: bool,
    extra_values: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """合作方输出：联系方式默认脱敏，与客户同口径（权限在路由层判定）。

    合作方联系人电话/微信/QQ 与客户联系方式同属敏感信息，之前 list/get 直接
    明文序列化，任何持 counterparty.read 的角色（含 EMPLOYEE）都能拿到全量号码。
    这里复用 mask_phone / mask_id，未获 customer.contact.read 时只回显遮罩值。
    """
    payload = {
        "id": counterparty.id,
        "counterparty_no": counterparty.counterparty_no,
        "display_name": counterparty.display_name,
        "type": counterparty.type,
        "contact_name": counterparty.contact_name,
        "phone": counterparty.phone,
        "wechat": counterparty.wechat,
        "qq": counterparty.qq,
        "source": counterparty.source,
        "status": counterparty.status,
        "note": counterparty.note,
        "created_at": counterparty.created_at,
        "extra_values": dict(extra_values or {}),
        "contact_masked": False,
    }
    if reveal_contact:
        return payload
    payload["phone"] = mask_phone(counterparty.phone)
    payload["wechat"] = mask_id(counterparty.wechat)
    payload["qq"] = mask_id(counterparty.qq)
    payload["contact_masked"] = True
    return payload




