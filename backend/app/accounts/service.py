"""accounts.service：游戏账号台账（ACC-01）。

账号成本由 `BUY` + `COST` 事件累计（ACC-01-04），状态只由订单事件驱动（ACC-01-03），
本模块不提供任何直接改成本或改状态的入口。
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.core.numbering import allocate_number
from app.domain.enums import AccountStatus, AuditAction, SequenceKey
from app.domain.trade import Account

INVENTORY_STATUSES = (AccountStatus.IN_STOCK.value, AccountStatus.INSTALLMENT.value)


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
    region: str | None = None,
    risk_level: str | None = None,
    account_description: str | None = None,
    account_images: list[str] | None = None,
    note: str | None = None,
) -> Account:
    identifier = (game_account or "").strip()
    if not identifier:
        raise Validation("账号标识必填", details={"field": "game_account"})
    exists = session.scalar(select(Account).where(Account.game_account == identifier))
    if exists is not None:
        raise Conflict(
            f"账号 {identifier} 已在台账中（{exists.inventory_no}）",
            code=ErrorCode.DUPLICATE_CODE,
            details={"inventory_no": exists.inventory_no},
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
        region=region,
        status=AccountStatus.IN_STOCK.value,
        risk_level=risk_level,
        account_description=account_description,
        account_images=account_images or [],
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(account)
    session.flush()
    return account


def get_account(session: Session, account_id: int) -> Account:
    account = session.get(Account, account_id)
    if account is None:
        raise NotFound(f"账号 {account_id} 不存在", details={"account_id": account_id})
    return account


def update_account_profile(
    session: Session,
    account_id: int,
    *,
    actor: str,
    game_account: str | None = None,
    game_type: str | None = None,
    game_password: str | None = None,
    channel_region: str | None = None,
    bound_phone: str | None = None,
    has_secondary: bool | None = None,
    platform: str | None = None,
    account_description: str | None = None,
    account_images: list[str] | None = None,
    note: str | None = None,
) -> Account:
    account = get_account(session, account_id)
    before = {
        "game_account": account.game_account,
        "game_type": account.game_type,
        "game_password": account.game_password,
        "channel_region": account.channel_region,
        "bound_phone": account.bound_phone,
        "has_secondary": account.has_secondary,
        "platform": account.platform,
        "account_description": account.account_description,
        "account_images": account.account_images or [],
        "note": account.note,
    }
    if game_account is not None:
        identifier = game_account.strip()
        if not identifier:
            raise Validation("账号标识必填", details={"field": "game_account"})
        exists = session.scalar(select(Account).where(Account.game_account == identifier, Account.id != account_id))
        if exists is not None:
            raise Conflict(
                f"账号 {identifier} 已在台账中（{exists.inventory_no}）",
                code=ErrorCode.DUPLICATE_CODE,
                details={"inventory_no": exists.inventory_no},
            )
        account.game_account = identifier
    for field, value in {
        "game_type": game_type,
        "game_password": game_password,
        "channel_region": channel_region,
        "bound_phone": bound_phone,
        "has_secondary": has_secondary,
        "platform": platform,
        "account_description": account_description,
        "account_images": account_images[:9] if account_images is not None else None,
        "note": note,
    }.items():
        if value is not None:
            setattr(account, field, value)
    account.updated_by = actor
    session.flush()
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
            "game_password": account.game_password,
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


def list_accounts(session: Session, *, status: str | None = None) -> list[Account]:
    stmt = select(Account)
    if status:
        stmt = stmt.where(Account.status == status)
    return list(session.scalars(stmt.order_by(Account.id)).all())


def inventory(session: Session) -> list[dict[str, Any]]:
    """库存健康表 R1（简化版）：只统计在库与分期中的真实占用。"""
    rows = session.scalars(
        select(Account).where(Account.status.in_(INVENTORY_STATUSES)).order_by(Account.id)
    ).all()
    return [
        {
            "account_id": row.id,
            "inventory_no": row.inventory_no,
            "platform": row.platform,
            "status": row.status,
            "cost_amount": to_money(row.cost_amount),
        }
        for row in rows
    ]


def total_inventory_cost(session: Session) -> Decimal:
    return to_money(
        sum((to_money(row.cost_amount) for row in _inventory_rows(session)), Decimal("0"))
    )


def _inventory_rows(session: Session) -> list[Account]:
    return list(
        session.scalars(
            select(Account).where(Account.status.in_(INVENTORY_STATUSES))
        ).all()
    )


__all__ = [
    "create_account",
    "get_account",
    "inventory",
    "list_accounts",
    "total_inventory_cost",
]
