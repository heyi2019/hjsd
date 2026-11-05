"""账号资料与账号建档服务。"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Conflict, NotFound, Validation
from app.core.numbering import allocate_number
from app.core.security import CurrentUser
from app.domain.enums import AccountStatus, AuditAction, InstallmentContractType, SequenceKey
from app.domain.imports import ImportRow
from app.domain.trade import Account, InstallmentDisposition, Order
from app.parties import service as parties_service
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
    platform: str | None = None,
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
        platform=platform,
        status=AccountStatus.WAITING.value,
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
            "camp_account": account.camp_account,
            "stock_no": account.stock_no,
            "game_type": account.game_type,
            "business_mode": account.business_mode,
            "inventory_type": account.inventory_type,
            "value_added_service": account.value_added_service,
            "platform": account.platform,
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
        "camp_account": account.camp_account,
        "game_type": account.game_type,
        "channel_region": account.channel_region,
        "bound_phone": account.bound_phone,
        "has_secondary": account.has_secondary,
        "secondary_images": account.secondary_images or [],
        "wallet_realname": account.wallet_realname,
        "wallet_realname_images": account.wallet_realname_images or [],
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
            "camp_account": account.camp_account,
            "game_type": account.game_type,
            "channel_region": account.channel_region,
            "bound_phone": account.bound_phone,
            "has_secondary": account.has_secondary,
            "secondary_images": account.secondary_images or [],
            "wallet_realname": account.wallet_realname,
            "wallet_realname_images": account.wallet_realname_images or [],
            "platform": account.platform,
            "account_description": account.account_description,
            "account_images": account.account_images or [],
            "note": account.note,
        },
    )
    return account


def delete_account(
    session: Session,
    account_id: int,
    *,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
) -> None:
    """物理删除库存账号（仅管理员），业务单据全部保留。

    口径（2026-11-05 裁决）：账号行删除，**订单 / 事件 / 资金流水 / 返点一律保留**，
    订单里的 ``account_snapshot`` 仍保存账号文本，报表按订单取数不受影响。
    关联解绑由本服务显式完成（而不是只靠数据库 ON DELETE SET NULL）：
    生产库是增量升级而来，外键行为以这份代码为准，避免老库 FK 定义不一致时
    删除直接撞约束或留下悬空引用。

    ``installment_dispositions.account_id`` 是 RESTRICT 且非空，必须显式拦截，
    否则 flush 抛底层 IntegrityError，用户只看到 500 且不知道该怎么处理。
    删除原因与账号快照写入审计日志，删除本身不可恢复。
    """
    account = get_account(session, account_id, user)
    cleaned_reason = reason.strip()
    if not cleaned_reason:
        raise Validation("删除原因不能为空", details={"field": "reason"})
    if session.scalar(
        select(InstallmentDisposition.id)
        .where(InstallmentDisposition.account_id == account_id)
        .limit(1)
    ) is not None:
        raise Conflict("该账号存在分期处置记录，不能删除，请先处理分期")
    linked_orders = [
        {"id": order_id, "order_no": order_no}
        for order_id, order_no in session.execute(
            select(Order.id, Order.order_no).where(Order.account_id == account_id)
        ).all()
    ]
    import_row_count = session.query(ImportRow).filter(
        ImportRow.mapped_account_id == account_id
    ).count()
    before = {
        "id": account.id,
        "stock_no": account.stock_no,
        "game_account": account.game_account,
        "camp_account": account.camp_account,
        "game_type": account.game_type,
        "business_mode": account.business_mode,
        "inventory_type": account.inventory_type,
        "value_added_service": account.value_added_service,
        "platform": account.platform,
        "status": account.status,
        "inventory_status": account.inventory_status,
        "cost_amount": str(account.cost_amount),
        "buy_date": account.buy_date.isoformat() if account.buy_date else None,
        "inventory_entry_at": account.inventory_entry_at.isoformat() if account.inventory_entry_at else None,
        "note": account.note,
        "created_by": account.created_by,
    }
    session.query(Order).filter(Order.account_id == account_id).update(
        {Order.account_id: None}, synchronize_session=False
    )
    session.query(ImportRow).filter(ImportRow.mapped_account_id == account_id).update(
        {ImportRow.mapped_account_id: None}, synchronize_session=False
    )
    session.delete(account)
    session.flush()
    record_audit(
        session,
        action=AuditAction.ACCOUNT_DELETE,
        entity_type="account",
        entity_id=str(account_id),
        actor=actor,
        before=before,
        after={
            "deleted": True,
            "unlinked_orders": linked_orders,
            "unlinked_import_rows": import_row_count,
        },
        reason=cleaned_reason,
    )


__all__ = ["create_account", "delete_account", "get_account", "update_account_profile"]
