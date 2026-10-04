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
    platform: str | None = None,
    region: str | None = None,
    risk_level: str | None = None,
    note: str | None = None,
) -> Account:
    identifier = (game_account or "").strip()
    if not identifier:
        raise Validation("账号标识必填", details={"field": "game_account"})
    exists = session.scalar(select(Account).where(Account.game_account == identifier))
    if exists is not None:
        raise Conflict(
            f"账号 {identifier} 已在台账中（{exists.account_no}）",
            code=ErrorCode.DUPLICATE_CODE,
            details={"account_no": exists.account_no},
        )
    account = Account(
        account_no=allocate_number(session, SequenceKey.ACCOUNT),
        game_account=identifier,
        platform=platform,
        region=region,
        status=AccountStatus.PENDING.value,
        risk_level=risk_level,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(account)
    session.flush()
    record_audit(
        session,
        action=AuditAction.CUSTOMER_CREATE,
        entity_type="account",
        entity_id=account.account_no,
        actor=actor,
        after={"platform": platform, "status": account.status},
    )
    return account


def get_account(session: Session, account_id: int) -> Account:
    account = session.get(Account, account_id)
    if account is None:
        raise NotFound(f"账号 {account_id} 不存在", details={"account_id": account_id})
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
            "account_no": row.account_no,
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
