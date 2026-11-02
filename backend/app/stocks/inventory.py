"""库存中心查询与库存成本汇总。"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.trade import Account
from app.parties import service as parties_service
from ._common import INVENTORY_STATUSES, scope_filter


def list_accounts(
    session: Session, *, status: str | None = None, user: CurrentUser | None = None,
    limit: int | None = None, offset: int = 0,
) -> list[Account]:
    # 账号台账包含所有业务类型的库存实体；库存健康与成本统计使用同一口径。
    stmt = select(Account)
    if status:
        stmt = stmt.where(Account.status == status)
    scope = scope_filter(session, user)
    if scope is not None:
        stmt = stmt.where(scope)
    stmt = stmt.order_by(Account.id)
    if limit is not None:
        stmt = stmt.limit(limit).offset(offset)
    return list(session.scalars(stmt).all())


def count_accounts(session: Session, *, status: str | None = None, user: CurrentUser | None = None) -> int:
    stmt = select(Account)
    if status:
        stmt = stmt.where(Account.status == status)
    scope = scope_filter(session, user)
    if scope is not None:
        stmt = stmt.where(scope)
    return int(session.scalar(select(func.count()).select_from(stmt.subquery())) or 0)


def inventory(session: Session, *, user: CurrentUser | None = None) -> list[dict[str, Any]]:
    """库存健康表：只统计独立库存状态为在库的真实占用。"""
    rows = [
        row for row in list_accounts(session, user=user)
        if row.inventory_status in INVENTORY_STATUSES
    ]
    extra_values = parties_service.get_extra_values_bulk(
        session, entity_type="account", entity_ids=[row.id for row in rows]
    )
    return [
        {
            "account_id": row.id,
            "game_account": row.game_account,
            "business_mode": row.business_mode,
            "inventory_type": row.inventory_type,
            "platform": row.platform,
            "status": row.status,
            "inventory_status": row.inventory_status,
            "inventory_entry_at": row.inventory_entry_at,
            "cost_amount": to_money(row.cost_amount),
            "account_description": row.account_description,
            "account_images": row.account_images or [],
            "extra_values": extra_values.get(row.id, {}),
        }
        for row in rows
    ]


def total_inventory_cost(session: Session, *, user: CurrentUser | None = None) -> Decimal:
    return to_money(sum((to_money(row.cost_amount) for row in _inventory_rows(session, user=user)), Decimal("0")))


def _inventory_rows(session: Session, *, user: CurrentUser | None = None) -> list[Account]:
    stmt = select(Account).where(
        Account.inventory_status.in_(INVENTORY_STATUSES),
    )
    scope = scope_filter(session, user)
    if scope is not None:
        stmt = stmt.where(scope)
    return list(session.scalars(stmt).all())


__all__ = ["count_accounts", "inventory", "list_accounts", "total_inventory_cost"]
