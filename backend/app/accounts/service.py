"""accounts.service：游戏账号台账（ACC-01）。

账号成本由 `BUY` + `COST` 事件累计（ACC-01-04），状态只由订单事件驱动（ACC-01-03），
本模块不提供任何直接改成本或改状态的入口。
"""
from __future__ import annotations

from decimal import Decimal
from collections.abc import Mapping
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.core.numbering import allocate_number
from app.core.security import CurrentUser, owner_scope_ids
from app.domain.enums import (
    AccountStatus,
    AuditAction,
    BusinessMode,
    InventoryType,
    SequenceKey,
)
from app.domain.trade import Account, Order
from app.parties import service as parties_service

INVENTORY_STATUSES = (
    AccountStatus.IN_STOCK.value,
    AccountStatus.INSTALLMENT.value,
)
_UNSET = object()


def _validate_account_images(value: list[str] | None) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        raise Validation("账号图片必须为数组", details={"field": "account_images"})
    images = value
    if len(images) > 9:
        raise Validation("账号图片最多 9 张", details={"field": "account_images", "max": 9})
    if any(not isinstance(image, str) or not image.strip() for image in images):
        raise Validation("账号图片必须为非空文本", details={"field": "account_images"})
    return images


def _validate_optional_bool(value: object, *, field: str) -> bool | None:
    if value is None:
        return None
    if not isinstance(value, bool):
        raise Validation(f"{field} 必须为布尔值", details={"field": field})
    return value


def _validate_inventory_context(
    business_mode: str | None,
    inventory_type: str | None,
) -> None:
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


def _validate_account_profile_scope(
    inventory_type: str | None,
    account_description: str | None | object,
    account_images: list[str] | None | object,
) -> None:
    """账号描述/图片只属于回收与代挂，提号账号不承载营销资料。"""
    has_description = account_description is not _UNSET and account_description not in (
        None,
        "",
    )
    has_images = account_images is not _UNSET and account_images not in (None, [])
    if inventory_type == InventoryType.PICKUP.value and (has_description or has_images):
        raise Validation(
            "账号描述和图片仅适用于回收或代挂",
            details={"field": "account_description/account_images", "inventory_type": inventory_type},
        )


def create_account(
    session: Session,
    *,
    game_account: str,
    actor: str,
    game_type: str | None = None,
    business_mode: str | None = None,
    inventory_type: str | None = None,
    game_password: str | None = None,
    channel_region: str | None = None,
    bound_phone: str | None = None,
    has_secondary: bool | None = None,
    platform: str | None = None,
    account_description: str | None = None,
    account_images: list[str] | None = None,
    note: str | None = None,
    extra_values: Mapping[str, Any] | None = None,
) -> Account:
    identifier = game_account.strip() if isinstance(game_account, str) else ""
    if not identifier:
        raise Validation("账号标识必填", details={"field": "game_account"})
    exists = session.scalar(select(Account).where(Account.game_account == identifier))
    if exists is not None:
        raise Conflict(
            f"账号 {identifier} 已在台账中（{exists.inventory_no}）",
            code=ErrorCode.DUPLICATE_CODE,
            details={"inventory_no": exists.inventory_no},
        )
    _validate_inventory_context(business_mode, inventory_type)
    has_secondary = _validate_optional_bool(has_secondary, field="has_secondary")
    validated_images = _validate_account_images(account_images)
    _validate_account_profile_scope(
        inventory_type, account_description, validated_images
    )
    account = Account(
        inventory_no=allocate_number(session, SequenceKey.ACCOUNT),
        game_type=game_type,
        business_mode=business_mode,
        inventory_type=inventory_type,
        game_account=identifier,
        game_password=game_password,
        channel_region=channel_region,
        bound_phone=bound_phone,
        has_secondary=has_secondary,
        platform=platform,
        status=AccountStatus.IN_STOCK.value,
        account_description=account_description,
        account_images=validated_images or [],
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(account)
    session.flush()
    parties_service.set_extra_values(
        session,
        entity_type="account",
        entity_id=account.id,
        values=(extra_values or {}).items(),
        require_all=True,
    )
    record_audit(
        session,
        action=AuditAction.ACCOUNT_CREATE,
        entity_type="account",
        entity_id=account.inventory_no,
        actor=actor,
        after={
            "inventory_no": account.inventory_no,
            "game_account": account.game_account,
            "game_type": account.game_type,
            "business_mode": account.business_mode,
            "inventory_type": account.inventory_type,
            "platform": account.platform,
            "status": account.status,
            "account_description": account.account_description,
            "account_images": account.account_images or [],
        },
    )
    return account


def _scope_filter(session: Session, user: CurrentUser | None):
    if user is None or user.is_admin or user.owner_scope == "ALL":
        return None
    visible_owner_ids = owner_scope_ids(session, user) or {user.id}
    linked_to_visible_order = select(Order.account_id).where(
        Order.account_id.is_not(None), Order.owner_id.in_(visible_owner_ids)
    )
    # 独立建档已不提供 API，但标准导入可能存在；创建者仍可看自己的未关联账号。
    return or_(
        Account.created_by == user.username,
        Account.id.in_(linked_to_visible_order),
    )


def account_is_visible(
    session: Session, account: Account, user: CurrentUser | None
) -> bool:
    predicate = _scope_filter(session, user)
    if predicate is None:
        return True
    return session.scalar(select(Account.id).where(Account.id == account.id, predicate)) is not None


def get_account(
    session: Session, account_id: int, user: CurrentUser | None = None
) -> Account:
    account = session.get(Account, account_id)
    if account is None:
        raise NotFound(f"账号 {account_id} 不存在", details={"account_id": account_id})
    if user is not None and not account_is_visible(session, account, user):
        raise NotFound(f"账号 {account_id} 不存在", details={"account_id": account_id})
    return account


def update_account_profile(
    session: Session,
    account_id: int,
    *,
    actor: str,
    game_account: str | None | object = _UNSET,
    game_type: str | None | object = _UNSET,
    game_password: str | None | object = _UNSET,
    channel_region: str | None | object = _UNSET,
    bound_phone: str | None | object = _UNSET,
    has_secondary: bool | None | object = _UNSET,
    platform: str | None | object = _UNSET,
    account_description: str | None | object = _UNSET,
    account_images: list[str] | None | object = _UNSET,
    note: str | None | object = _UNSET,
    extra_values: Mapping[str, Any] | None | object = _UNSET,
    user: CurrentUser | None = None,
) -> Account:
    account = get_account(session, account_id, user)
    before = {
        "game_account": account.game_account,
        "game_type": account.game_type,
        "channel_region": account.channel_region,
        "bound_phone": account.bound_phone,
        "has_secondary": account.has_secondary,
        "platform": account.platform,
        "account_description": account.account_description,
        "account_images": account.account_images or [],
        "note": account.note,
    }
    next_game_account = account.game_account
    if game_account is not _UNSET:
        identifier = game_account.strip() if isinstance(game_account, str) else ""
        if not identifier:
            raise Validation("账号标识必填", details={"field": "game_account"})
        exists = session.scalar(select(Account).where(Account.game_account == identifier, Account.id != account_id))
        if exists is not None:
            raise Conflict(
                f"账号 {identifier} 已在台账中（{exists.inventory_no}）",
                code=ErrorCode.DUPLICATE_CODE,
                details={"inventory_no": exists.inventory_no},
            )
        next_game_account = identifier
    validated_images = (
        _validate_account_images(account_images)
        if account_images is not _UNSET
        else _UNSET
    )
    _validate_account_profile_scope(
        account.inventory_type,
        account_description,
        validated_images,
    )
    has_secondary = (
        _validate_optional_bool(has_secondary, field="has_secondary")
        if has_secondary is not _UNSET
        else _UNSET
    )
    if game_account is not _UNSET:
        account.game_account = next_game_account
    for field, value in {
        "game_type": game_type,
        "game_password": game_password,
        "channel_region": channel_region,
        "bound_phone": bound_phone,
        "has_secondary": has_secondary,
        "platform": platform,
        "account_description": account_description,
        "account_images": validated_images,
        "note": note,
    }.items():
        if value is _UNSET:
            continue
        setattr(account, field, value)
    account.updated_by = actor
    session.flush()
    if extra_values is not _UNSET:
        parties_service.set_extra_values(
            session,
            entity_type="account",
            entity_id=account.id,
            values=(extra_values or {}).items(),
        )
    record_audit(
        session,
        action=AuditAction.ACCOUNT_UPDATE,
        entity_type="account",
        entity_id=account.inventory_no,
        actor=actor,
        before=before,
        after={
            "game_account": account.game_account,
            "game_type": account.game_type,
            "channel_region": account.channel_region,
            "bound_phone": account.bound_phone,
            "has_secondary": account.has_secondary,
            "platform": account.platform,
            "account_description": account.account_description,
            "account_images": account.account_images or [],
            "note": account.note,
        },
    )
    return account


def list_accounts(
    session: Session,
    *,
    status: str | None = None,
    user: CurrentUser | None = None,
) -> list[Account]:
    # 提号只保留在 TH 订单的账号文本快照，不属于库存资产。
    stmt = select(Account).where(
        or_(
            Account.inventory_type.is_(None),
            Account.inventory_type != InventoryType.PICKUP.value,
        )
    )
    if status:
        stmt = stmt.where(Account.status == status)
    scope = _scope_filter(session, user)
    if scope is not None:
        stmt = stmt.where(scope)
    return list(session.scalars(stmt.order_by(Account.id)).all())


def inventory(
    session: Session, *, user: CurrentUser | None = None
) -> list[dict[str, Any]]:
    """库存健康表 R1（简化版）：只统计在库与分期中的真实占用。"""
    rows = list_accounts(session, user=user)
    rows = [
        row
        for row in rows
        if row.status in INVENTORY_STATUSES
        and row.inventory_type != InventoryType.PICKUP.value
    ]
    extra_values = parties_service.get_extra_values_bulk(
        session, entity_type="account", entity_ids=[row.id for row in rows]
    )
    return [
        {
            "account_id": row.id,
            "inventory_no": row.inventory_no,
            "game_account": row.game_account,
            "business_mode": row.business_mode,
            "inventory_type": row.inventory_type,
            "platform": row.platform,
            "status": row.status,
            "cost_amount": to_money(row.cost_amount),
            "account_description": row.account_description,
            "account_images": row.account_images or [],
            "extra_values": extra_values.get(row.id, {}),
        }
        for row in rows
    ]


def total_inventory_cost(
    session: Session, *, user: CurrentUser | None = None
) -> Decimal:
    return to_money(
        sum(
            (to_money(row.cost_amount) for row in _inventory_rows(session, user=user)),
            Decimal("0"),
        )
    )


def _inventory_rows(
    session: Session, *, user: CurrentUser | None = None
) -> list[Account]:
    stmt = select(Account).where(
        Account.status.in_(INVENTORY_STATUSES),
        or_(
            Account.inventory_type.is_(None),
            Account.inventory_type != InventoryType.PICKUP.value,
        ),
    )
    scope = _scope_filter(session, user)
    if scope is not None:
        stmt = stmt.where(scope)
    return list(session.scalars(stmt).all())


__all__ = [
    "create_account",
    "account_is_visible",
    "get_account",
    "inventory",
    "list_accounts",
    "total_inventory_cost",
]
