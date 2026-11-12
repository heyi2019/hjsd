"""parties 领域共用的字段规则和客户输出转换。"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.domain.parties import (
    Counterparty,
    Customer,
)
from app.domain.users import User

CONTACT_FIELDS: tuple[str, ...] = ("contact_name", "phone", "wechat", "qq", "note")
_UNSET = object()

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




