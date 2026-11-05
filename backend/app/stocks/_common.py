"""账号域共享校验、库存口径与可见范围。"""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.core.security import CurrentUser, owner_scope_ids
from app.domain.enums import (
    BusinessMode,
    InventoryAgeLevel,
    InventoryStatus,
    InventoryType,
    WalletRealName,
)
from app.domain.trade import Account, Order

# 只按独立库存状态统计；分期状态属于 installments，不再占用库存口径。
INVENTORY_STATUSES = (InventoryStatus.IN_STOCK.value,)
_UNSET = object()

# 库龄档位阈值：7 天内正常、8–30 天预警、超过 30 天超期。
# 与 InventoryAgeLevel 一一对应，前后端不得各写一份。
AGE_NORMAL_MAX_DAYS = 7
AGE_WARNING_MAX_DAYS = 30


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


def validate_secondary_images(value: list[str] | None) -> list[str] | None:
    """二次验证佐证图：与账号图片同构，但最多 3 张。"""
    images = validate_account_images(value)
    if images is not None and len(images) > 3:
        raise Validation("二次图片最多 3 张", details={"field": "secondary_images", "max": 3})
    return images


def validate_optional_bool(value: object, *, field: str) -> bool | None:
    if value is None:
        return None
    if not isinstance(value, bool):
        raise Validation(f"{field} 必须为布尔值", details={"field": field})
    return value


def validate_camp_account(value: object) -> str | None:
    """营地账号：可空自由文本，只做去空格与长度约束，不参与核算。"""
    if value is None:
        return None
    if not isinstance(value, str):
        raise Validation("营地账号必须为文本", details={"field": "camp_account"})
    cleaned = value.strip()
    if not cleaned:
        return None
    if len(cleaned) > 128:
        raise Validation(
            "营地账号长度不能超过 128 个字符",
            details={"field": "camp_account", "max": 128},
        )
    return cleaned


def validate_wallet_realname(value: object) -> str | None:
    """钱包实名只接受「未注销 / 已注销」，空值视作未登记。"""
    if value is None:
        return None
    if not isinstance(value, str):
        raise Validation("钱包实名必须为文本", details={"field": "wallet_realname"})
    cleaned = value.strip()
    if not cleaned:
        return None
    if cleaned not in WalletRealName.values():
        raise Validation(
            "钱包实名取值无效",
            details={"field": "wallet_realname", "value": cleaned,
                     "allowed": list(WalletRealName.values())},
        )
    return cleaned


def validate_inventory_context(business_mode: str | None, inventory_type: str | None) -> None:
    if business_mode is not None and business_mode not in BusinessMode.values():
        raise Validation("业务模式无效", details={"field": "business_mode"})
    if inventory_type is not None and inventory_type not in InventoryType.values():
        raise Validation("业务类型无效", details={"field": "inventory_type"})
    if business_mode is None or inventory_type is None:
        return
    allowed_types = {
        BusinessMode.SELF.value: {InventoryType.RECOVERY.value},
        BusinessMode.DISTRIBUTION.value: {
            InventoryType.PICKUP.value,
            InventoryType.CONSIGNMENT.value,
        },
    }[business_mode]
    if inventory_type not in allowed_types:
        raise Validation(
            "业务模式与业务类型不匹配",
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


def inventory_age_days(entry: date | datetime | None, *, today: date | None = None) -> int | None:
    """库龄（自然日）：入库日与今天的日期差，不按「满 24 小时」计。

    入库存时间带时分秒（如 09:30）时，按满 24 小时算会让「8 天前入库」显示成 7 天，
    且数字会随当天时刻跳动；台账上的「未售时长」应与「入库时间」那一列读起来一致，
    故一律取日期差。未来时间（补录/时区差）夹到 0，无入库时间返回 None。
    """
    if entry is None:
        return None
    entry_date = entry.date() if isinstance(entry, datetime) else entry
    return max(0, ((today or date.today()) - entry_date).days)


def inventory_age_level(days: int | None) -> str | None:
    """库龄档位：None 透传（非在库或无入库时间），阈值只在此处定义。"""
    if days is None:
        return None
    if days <= AGE_NORMAL_MAX_DAYS:
        return InventoryAgeLevel.NORMAL.value
    if days <= AGE_WARNING_MAX_DAYS:
        return InventoryAgeLevel.WARNING.value
    return InventoryAgeLevel.OVERDUE.value


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
    "AGE_NORMAL_MAX_DAYS",
    "AGE_WARNING_MAX_DAYS",
    "INVENTORY_STATUSES",
    "_UNSET",
    "account_is_visible",
    "inventory_age_days",
    "inventory_age_level",
    "scope_filter",
    "validate_account_images",
    "validate_account_profile_scope",
    "validate_camp_account",
    "validate_inventory_context",
    "validate_optional_bool",
    "validate_secondary_images",
]
