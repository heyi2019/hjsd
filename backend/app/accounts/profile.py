"""账号资料与账号建档服务。"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.numbering import allocate_number
from app.core.security import CurrentUser
from app.domain.enums import AccountStatus, AuditAction, InstallmentContractType
from app.domain.trade import Account
from app.parties import service as parties_service
from ._common import (
    _UNSET,
    account_is_visible,
    validate_account_images,
    validate_account_profile_scope,
    validate_inventory_context,
    validate_optional_bool,
)


def create_account(
    session: Session,
    *,
    game_account: str,
    actor: str,
    game_type: str | None = None,
    business_mode: str | None = None,
    inventory_type: str | None = None,
    value_added_service: str | None = None,
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
        raise Validation("库存编号必填", details={"field": "game_account"})
    exists = session.scalar(select(Account).where(Account.game_account == identifier))
    if exists is not None:
        raise Conflict(
            f"账号 {identifier} 已在台账中",
            code=ErrorCode.DUPLICATE_CODE,
            details={"game_account": identifier},
        )
    validate_inventory_context(business_mode, inventory_type)
    if value_added_service is not None and value_added_service not in {
        InstallmentContractType.STOCK_SALE.value,
        InstallmentContractType.ADVANCE_PURCHASE.value,
    }:
        raise Validation(
            "增值服务无效",
            details={"field": "value_added_service", "value": value_added_service},
        )
    has_secondary = validate_optional_bool(has_secondary, field="has_secondary")
    validated_images = validate_account_images(account_images)
    validate_account_profile_scope(inventory_type, account_description, validated_images)
    account = Account(
        game_type=game_type,
        business_mode=business_mode,
        inventory_type=inventory_type,
        value_added_service=value_added_service,
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
        entity_id=str(account.id),
        actor=actor,
        after={
            "game_account": account.game_account,
            "game_type": account.game_type,
            "business_mode": account.business_mode,
            "inventory_type": account.inventory_type,
            "value_added_service": account.value_added_service,
            "platform": account.platform,
            "status": account.status,
            "account_description": account.account_description,
            "account_images": account.account_images or [],
        },
    )
    return account


def get_account(session: Session, account_id: int, user: CurrentUser | None = None) -> Account:
    account = session.get(Account, account_id)
    if account is None or (user is not None and not account_is_visible(session, account, user)):
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
    form_extra: Mapping[str, Any] | None | object = _UNSET,
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
            raise Validation("库存编号必填", details={"field": "game_account"})
        exists = session.scalar(select(Account).where(Account.game_account == identifier, Account.id != account_id))
        if exists is not None:
            raise Conflict(
                f"账号 {identifier} 已在台账中（账号ID {exists.id}）",
                code=ErrorCode.DUPLICATE_CODE,
                details={"account_id": exists.id},
            )
        next_game_account = identifier
    validated_images = validate_account_images(account_images) if account_images is not _UNSET else _UNSET
    validate_account_profile_scope(account.inventory_type, account_description, validated_images)
    normalized_secondary = (
        validate_optional_bool(has_secondary, field="has_secondary")
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
        "has_secondary": normalized_secondary,
        "platform": platform,
        "account_description": account_description,
        "account_images": validated_images,
        "note": note,
    }.items():
        if value is not _UNSET:
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
    if form_extra is not _UNSET and form_extra:
        # INVEDIT 作用域自定义字段值合并进账号 form_extra。
        account.form_extra = {**(account.form_extra or {}), **dict(form_extra)}
    record_audit(
        session,
        action=AuditAction.ACCOUNT_UPDATE,
        entity_type="account",
        entity_id=str(account.id),
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


__all__ = ["create_account", "get_account", "update_account_profile"]
