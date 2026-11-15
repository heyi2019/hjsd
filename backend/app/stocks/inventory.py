"""库存中心查询与库存成本汇总。"""
from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.trade import Account
from app.parties.fields import get_extra_values_bulk
from ._common import (
    AGE_WARNING_MAX_DAYS,
    INVENTORY_STATUSES,
    inventory_age_days as age_days,
    scope_filter,
)


def list_accounts(
    session: Session, *, status: str | None = None, user: CurrentUser | None = None,
    inventory_status: str | None = None, limit: int | None = None, offset: int = 0,
) -> list[Account]:
    # 账号台账包含所有业务类型的库存实体；在库台账与成本统计使用同一口径。
    stmt = select(Account)
    if status:
        stmt = stmt.where(Account.status == status)
    if inventory_status:
        stmt = stmt.where(Account.inventory_status == inventory_status)
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
    """库存中心在库台账：只统计独立库存状态为在库的真实占用。"""
    rows = list_accounts(session, inventory_status=next(iter(INVENTORY_STATUSES)), user=user)
    extra_values = get_extra_values_bulk(
        session, entity_type="account", entity_ids=[row.id for row in rows]
    )
    return [
        {
            "account_id": row.id,
            "stock_no": row.stock_no,
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


def inventory_cost_by_entry_date(
    session: Session,
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    user: CurrentUser | None = None,
) -> Decimal:
    """按入库日期汇总仍在库账号成本，不加载库存明细。"""
    stmt = select(func.coalesce(func.sum(Account.cost_amount), 0)).where(
        Account.inventory_status.in_(INVENTORY_STATUSES)
    )
    if date_from is not None:
        stmt = stmt.where(
            Account.inventory_entry_at >= datetime.combine(date_from, time.min)
        )
    if date_to is not None:
        stmt = stmt.where(
            Account.inventory_entry_at < datetime.combine(date_to + timedelta(days=1), time.min)
        )
    scope = scope_filter(session, user)
    if scope is not None:
        stmt = stmt.where(scope)
    return to_money(session.scalar(stmt) or 0)


def inventory_stats(
    session: Session,
    *,
    account_ids: Sequence[int],
    today: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """按给定账号集合汇总库存卡片指标。

    集合由调用方（界面上当前可见的行）给出，避免筛选口径在前后端各写一份；
    金额与库龄全部在此按后端口径算好，前端只负责展示。
    """
    ids = [int(item) for item in dict.fromkeys(account_ids)]
    if not ids:
        return {
            "account_count": 0,
            "occupied_cost": to_money(Decimal("0")),
            "over_7d_count": 0,
            "over_30d_count": 0,
        }
    stmt = select(Account).where(Account.id.in_(ids), Account.inventory_status.in_(INVENTORY_STATUSES))
    scope = scope_filter(session, user)
    if scope is not None:
        stmt = stmt.where(scope)
    rows = list(session.scalars(stmt).all())
    reference = today or date.today()
    over_7d = 0
    over_30d = 0
    for row in rows:
        age = inventory_age_days(row, today=reference)
        if age is None:
            continue
        if age > 7:
            over_7d += 1
        if age > 30:
            over_30d += 1
    return {
        "account_count": len(rows),
        "occupied_cost": to_money(sum((to_money(row.cost_amount) for row in rows), Decimal("0"))),
        "over_7d_count": over_7d,
        "over_30d_count": over_30d,
    }


def dashboard_inventory_summary(
    session: Session,
    *,
    reminder_days: int,
    today: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, int]:
    """工作台库存卡片与提醒所需的计数，保留 WAITING 订单状态口径。"""
    stmt = select(Account.inventory_entry_at).where(Account.status == "WAITING")
    scope = scope_filter(session, user)
    if scope is not None:
        stmt = stmt.where(scope)
    entries = list(session.scalars(stmt).all())
    reference = today or date.today()
    aging_count = 0
    overdue_count = 0
    for entry_at in entries:
        age = age_days(entry_at, today=reference)
        if age is None:
            continue
        if age > reminder_days:
            aging_count += 1
        if age > AGE_WARNING_MAX_DAYS:
            overdue_count += 1
    return {
        "account_count": len(entries),
        "aging_count": aging_count,
        "overdue_count": overdue_count,
    }


def inventory_age_days(row: Account, *, today: date | None = None) -> int | None:
    """库龄（自然日）只以入库存时间为准。"""
    return age_days(row.inventory_entry_at, today=today)


def _inventory_rows(session: Session, *, user: CurrentUser | None = None) -> list[Account]:
    stmt = select(Account).where(
        Account.inventory_status.in_(INVENTORY_STATUSES),
    )
    scope = scope_filter(session, user)
    if scope is not None:
        stmt = stmt.where(scope)
    return list(session.scalars(stmt).all())


__all__ = [
    "count_accounts",
    "dashboard_inventory_summary",
    "inventory",
    "inventory_age_days",
    "inventory_cost_by_entry_date",
    "inventory_stats",
    "list_accounts",
    "total_inventory_cost",
]
