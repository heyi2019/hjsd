"""账号资料与账号建档服务。"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import NotFound, Validation
from app.shared.numbering import allocate_number
from app.core.security import CurrentUser
from app.domain.enums import AccountStatus, AuditAction, InstallmentContractType, SequenceKey
from app.domain.trade import Account
from app.shared.form_values import _validate_required_extras, set_extra_values
from app.shared.form_field_rules import validate_form_extra
from ._common import (
    _UNSET,
    account_is_visible,
    validate_account_images,
    validate_account_profile_scope,
    validate_inventory_context,
    validate_camp_account,
    validate_optional_bool,
    validate_secondary_images,
    validate_wallet_realname,
)

_ACCOUNT_FORM_SCOPE = {"RECOVERY": "HS", "PICKUP": "TH", "CONSIGNMENT": "DG"}


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
    camp_account: str | None = None,
    channel_region: str | None = None,
    bound_phone: str | None = None,
    has_secondary: bool | None = None,
    secondary_images: list[str] | None = None,
    wallet_realname: str | None = None,
    wallet_realname_images: list[str] | None = None,
    account_description: str | None = None,
    account_images: list[str] | None = None,
    note: str | None = None,
    extra_values: Mapping[str, Any] | None = None,
) -> Account:
    identifier = game_account.strip() if isinstance(game_account, str) else ""
    if not identifier:
        raise Validation("库存编号必填", details={"field": "game_account"})
    # 2026-10-28 口径：game_account 不唯一——同一游戏账号可反复回购，
    # 每次收购都是独立库存实体（各自成本与生命周期），不做查重限制。
    validate_inventory_context(business_mode, inventory_type)
    if value_added_service is not None and value_added_service != InstallmentContractType.STOCK_SALE.value:
        raise Validation(
            "增值服务无效",
            details={"field": "value_added_service", "value": value_added_service},
        )
    stock_no = allocate_number(session, SequenceKey.STOCK_NO)
    has_secondary = validate_optional_bool(has_secondary, field="has_secondary")
    camp_account = validate_camp_account(camp_account)
    validated_secondary_images = validate_secondary_images(secondary_images)
    wallet_realname = validate_wallet_realname(wallet_realname)
    validated_wallet_images = validate_secondary_images(wallet_realname_images)
    validated_images = validate_account_images(account_images)
    validate_account_profile_scope(inventory_type, account_description, validated_images)
    account = Account(
        game_type=game_type,
        business_mode=business_mode,
        inventory_type=inventory_type,
        value_added_service=value_added_service,
        stock_no=stock_no,
        game_account=identifier,
        camp_account=camp_account,
        game_password=game_password,
        channel_region=channel_region,
        bound_phone=bound_phone,
        has_secondary=has_secondary,
        secondary_images=validated_secondary_images,
        wallet_realname=wallet_realname,
        wallet_realname_images=validated_wallet_images,
        status=AccountStatus.WAITING.value,
        account_description=account_description,
        account_images=validated_images or [],
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(account)
    session.flush()
    set_extra_values(
        session,
        entity_type="account",
        entity_id=account.id,
        values=(extra_values or {}).items(),
        require_all=True,
        scope=_ACCOUNT_FORM_SCOPE.get(inventory_type),
    )
    record_audit(
        session,
        action=AuditAction.ACCOUNT_CREATE,
        entity_type="account",
        entity_id=account.stock_no,
        actor=actor,
        after={
            "game_account": account.game_account,
            "camp_account": account.camp_account,
            "stock_no": account.stock_no,
            "game_type": account.game_type,
            "business_mode": account.business_mode,
            "inventory_type": account.inventory_type,
            "value_added_service": account.value_added_service,
            "wallet_realname": account.wallet_realname,
            "wallet_realname_images": account.wallet_realname_images or [],
            "status": account.status,
            "account_description": account.account_description,
            "secondary_images": account.secondary_images or [],
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
    camp_account: str | None | object = _UNSET,
    channel_region: str | None | object = _UNSET,
    bound_phone: str | None | object = _UNSET,
    has_secondary: bool | None | object = _UNSET,
    secondary_images: list[str] | None | object = _UNSET,
    wallet_realname: str | None | object = _UNSET,
    wallet_realname_images: list[str] | None | object = _UNSET,
    account_description: str | None | object = _UNSET,
    account_images: list[str] | None | object = _UNSET,
    note: str | None | object = _UNSET,
    extra_values: Mapping[str, Any] | None | object = _UNSET,
    form_extra: Mapping[str, Any] | None | object = _UNSET,
    user: CurrentUser | None = None,
) -> Account:
    account = get_account(session, account_id, user)
    if extra_values is not _UNSET:
        _validate_required_extras(session, "account", extra_values or {}, partial=True,
                                  scope=_ACCOUNT_FORM_SCOPE.get(account.inventory_type))
    checked_form_extra = (
        validate_form_extra(session, order_type_code="INVEDIT", values=form_extra)
        if form_extra is not _UNSET else None
    )
    before = {
        "game_account": account.game_account,
        "camp_account": account.camp_account,
        "game_type": account.game_type,
        "channel_region": account.channel_region,
        "bound_phone": account.bound_phone,
        "has_secondary": account.has_secondary,
        "secondary_images": account.secondary_images or [],
        "wallet_realname": account.wallet_realname,
        "wallet_realname_images": account.wallet_realname_images or [],
        "account_description": account.account_description,
        "account_images": account.account_images or [],
        "note": account.note,
    }
    next_game_account = account.game_account
    if game_account is not _UNSET:
        identifier = game_account.strip() if isinstance(game_account, str) else ""
        if not identifier:
            raise Validation("库存编号必填", details={"field": "game_account"})
        # 2026-10-28 口径：game_account 不唯一（支持复购），改名不做查重。
        next_game_account = identifier
    validated_images = validate_account_images(account_images) if account_images is not _UNSET else _UNSET
    validate_account_profile_scope(account.inventory_type, account_description, validated_images)
    normalized_secondary = (
        validate_optional_bool(has_secondary, field="has_secondary")
        if has_secondary is not _UNSET
        else _UNSET
    )
    normalized_wallet = (
        validate_wallet_realname(wallet_realname) if wallet_realname is not _UNSET else _UNSET
    )
    normalized_wallet_images = (
        validate_secondary_images(wallet_realname_images)
        if wallet_realname_images is not _UNSET
        else _UNSET
    )
    normalized_secondary_images = (
        validate_secondary_images(secondary_images)
        if secondary_images is not _UNSET
        else _UNSET
    )
    normalized_camp = (
        validate_camp_account(camp_account) if camp_account is not _UNSET else _UNSET
    )
    if game_account is not _UNSET:
        account.game_account = next_game_account
    for field, value in {
        "game_type": game_type,
        "game_password": game_password,
        "camp_account": normalized_camp,
        "channel_region": channel_region,
        "bound_phone": bound_phone,
        "has_secondary": normalized_secondary,
        "secondary_images": normalized_secondary_images,
        "wallet_realname": normalized_wallet,
        "wallet_realname_images": normalized_wallet_images,
        "account_description": account_description,
        "account_images": validated_images,
        "note": note,
    }.items():
        if value is not _UNSET:
            setattr(account, field, value)
    account.updated_by = actor
    session.flush()
    if extra_values is not _UNSET:
        set_extra_values(
            session,
            entity_type="account",
            entity_id=account.id,
            values=(extra_values or {}).items(),
            scope=_ACCOUNT_FORM_SCOPE.get(account.inventory_type),
        )
    if checked_form_extra:
        # INVEDIT 作用域自定义字段值合并进账号 form_extra。
        account.form_extra = {**(account.form_extra or {}), **checked_form_extra}
    record_audit(
        session,
        action=AuditAction.ACCOUNT_UPDATE,
        entity_type="account",
        entity_id=account.stock_no,
        actor=actor,
        before=before,
        after={
            "game_account": account.game_account,
            "camp_account": account.camp_account,
            "game_type": account.game_type,
            "channel_region": account.channel_region,
            "bound_phone": account.bound_phone,
            "has_secondary": account.has_secondary,
            "secondary_images": account.secondary_images or [],
            "wallet_realname": account.wallet_realname,
            "wallet_realname_images": account.wallet_realname_images or [],
            "account_description": account.account_description,
            "account_images": account.account_images or [],
            "note": account.note,
        },
    )
    return account


__all__ = ["create_account", "get_account", "update_account_profile"]
