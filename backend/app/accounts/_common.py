"""账号域共享校验与可见范围。"""
from __future__ import annotations

from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.core.security import CurrentUser, owner_scope_ids
from app.domain.enums import AccountStatus, BusinessMode, InventoryType
from app.domain.trade import Account, Order

INVENTORY_STATUSES = (AccountStatus.IN_STOCK.value, AccountStatus.INSTALLMENT.value)
_UNSET = object()


def validate_account_images(value: list[str] | None) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        raise Validation("账号图片必须为数组", details={"field": "account_images"})
    if len(value) > 9:
        raise Validation("账号图片最多 9 张", details={"field": "account_images", "max": 9})
    if any(not isinstance(image, str) or not image.strip() for image in value):
        raise Validation("账号图片必须为非空文本", details={"field": "account_images"})
    return value


def validate_optional_bool(value: object, *, field: str) -> bool | None:
    if value is None:
        return None
    if not isinstance(value, bool):
        raise Validation(f"{field} 必须为布尔值", details={"field": field})
    return value


def validate_inventory_context(business_mode: str | None, inventory_type: str | None) -> None:
    if business_mode is not None and business_mode not in BusinessMode.values():
        raise Validation("业务模式无效", details={"field": "business_mode"})
    if inventory_type is not None and inventory_type not in InventoryType.values():
        raise Validation("库存类型无效", details={"field": "inventory_type"})
    if business_mode is None or inventory_type is None:
        return
    allowed_types = {
        BusinessMode.SELF.value: {InventoryType.RECOVERY.value},
        BusinessMode.DISTRIBUTION.value: {InventoryType.CONSIGNMENT.value},
    }[business_mode]
    if inventory_type not in allowed_types:
        raise Validation(
            "业务模式与库存类型不匹配",
            details={
                "field": "inventory_type",
                "business_mode": business_mode,
                "inventory_type": inventory_type,
            },
        )


def validate_account_profile_scope(
    inventory_type: str | None,
    account_description: str | None | object,
    account_images: list[str] | None | object,
) -> None:
    """账号描述/图片只属于回收与代挂，提号账号不承载营销资料。"""
    has_description = account_description is not _UNSET and account_description not in (None, "")
    has_images = account_images is not _UNSET and account_images not in (None, [])
    if inventory_type == InventoryType.PICKUP.value and (has_description or has_images):
        raise Validation(
            "账号描述和图片仅适用于回收或代挂",
            details={"field": "account_description/account_images", "inventory_type": inventory_type},
        )


def scope_filter(session: Session, user: CurrentUser | None):
    if user is None or user.is_admin or user.owner_scope == "ALL":
        return None
    visible_owner_ids = owner_scope_ids(session, user) or {user.id}
    linked_to_visible_order = select(Order.account_id).where(
        Order.account_id.is_not(None), Order.owner_id.in_(visible_owner_ids)
    )
    return or_(Account.created_by == user.username, Account.id.in_(linked_to_visible_order))


def account_is_visible(session: Session, account: Account, user: CurrentUser | None) -> bool:
    predicate = scope_filter(session, user)
    if predicate is None:
        return True
    return session.scalar(select(Account.id).where(Account.id == account.id, predicate)) is not None


__all__ = [
    "INVENTORY_STATUSES",
    "_UNSET",
    "account_is_visible",
    "scope_filter",
    "validate_account_images",
    "validate_account_profile_scope",
    "validate_inventory_context",
    "validate_optional_bool",
]
