"""库存中心查询与库存成本汇总。"""
from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import Date, case, cast, exists, func, or_, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.core.like_pattern import like_contains
from app.core.security import CurrentUser
from app.domain.trade import Account, Order, OrderEvent
from app.shared.form_values import get_extra_values_bulk
from app.shared.amount_search import amount_keyword
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


def _inventory_ledger_scope(session: Session, user: CurrentUser | None):
    stmt = select(Account, Order).join(Order, Order.account_id == Account.id).where(
        Account.status == "WAITING", Order.status.in_(("ACTIVE", "INSTALLMENT")),
    )
    scope = scope_filter(session, user)
    return stmt.where(scope) if scope is not None else stmt


def inventory_ledger(
    session: Session, *, business_mode: str | None = None,
    inventory_type: str | None = None, game_type: str | None = None,
    keyword: str | None = None, date_from: date | None = None,
    date_to: date | None = None, sort_desc: bool = True,
    inventory_operator_ids: list[int] | None = None,
    age_gt_days: int | None = None,
    limit: int | None = 10, offset: int = 0, user: CurrentUser | None = None,
) -> dict[str, Any]:
    """服务端筛选、排序、分页库存台账，并返回分页所需统计。"""
    type_expr = func.coalesce(
        Account.inventory_type,
        case((Order.order_type == "HS", "RECOVERY"), (Order.order_type == "TH", "PICKUP"),
             (Order.order_type == "DG", "CONSIGNMENT"), else_=None),
    )
    game_type_expr = func.coalesce(Account.game_type, Order.account_snapshot["game_type"].as_string())
    business_mode_expr = func.coalesce(
        Account.business_mode,
        Order.account_snapshot["business_mode"].as_string(),
    )
    entry_day = cast(
        func.date(func.coalesce(Account.inventory_entry_at, Order.trade_date, Account.created_at)),
        Date,
    )
    base_scope = _inventory_ledger_scope(session, user)

    def stmt(*, include_type: bool = True, include_search_date: bool = True):
        query = base_scope
        if business_mode:
            query = query.where(business_mode_expr == business_mode)
        if game_type:
            query = query.where(game_type_expr == game_type)
        if include_type and inventory_type:
            query = query.where(type_expr == inventory_type)
        if inventory_operator_ids:
            query = query.where(or_(*(
                cast(Order.form_extra, JSONB).contains({"business_responsible_ids": [operator_id]})
                for operator_id in inventory_operator_ids
            )))
        if age_gt_days is not None:
            query = query.where(entry_day < date.today() - timedelta(days=age_gt_days))
        if include_search_date:
            if keyword and keyword.strip():
                pattern, escape = like_contains(keyword.strip())
                amount = amount_keyword(keyword)
                conditions = [
                    func.coalesce(Account.game_account, Order.account_snapshot["game_account"].as_string()).ilike(pattern, escape=escape),
                    game_type_expr.ilike(pattern, escape=escape),
                    func.coalesce(Account.channel_region, Order.account_snapshot["channel_region"].as_string()).ilike(pattern, escape=escape),
                ]
                if amount is not None:
                    conditions.append(Account.cost_amount == amount)
                    conditions.append(exists(select(OrderEvent.id).where(
                        OrderEvent.order_id == Order.id, OrderEvent.event_type == "BUY",
                        OrderEvent.is_posted.is_(True), OrderEvent.amount == amount,
                    )))
                query = query.where(or_(*conditions))
            if date_from:
                query = query.where(entry_day >= date_from)
            if date_to:
                query = query.where(entry_day <= date_to)
        return query

    filtered = stmt()
    total = int(session.scalar(select(func.count()).select_from(filtered.subquery())) or 0)
    order_by = Order.id.desc() if sort_desc else Order.id.asc()
    items = list(session.execute(filtered.order_by(order_by).limit(limit).offset(offset)).all())
    facet_query = stmt(include_type=False, include_search_date=False).with_only_columns(
        type_expr, func.count(Account.id), maintain_column_froms=True,
    ).group_by(type_expr)
    facets = session.execute(facet_query).all()
    type_counts = {str(kind): int(count) for kind, count in facets if kind}
    facet_total = sum(int(count) for _kind, count in facets)
    # options remain available across the current business/game filters, like the prior UI.
    game_type_query = base_scope.with_only_columns(
        game_type_expr, maintain_column_froms=True,
    ).where(game_type_expr.is_not(None))
    game_type_query = game_type_query.distinct().order_by(game_type_expr)
    game_types = list(session.scalars(game_type_query).all())
    account_id_query = stmt().with_only_columns(Account.id, maintain_column_froms=True).distinct()
    # account_id_query 已包含相同账号权限范围，无需在汇总外层重复解析团队成员。
    stats = _inventory_stats_for_filter(session, account_id_query)
    return {"items": items, "total": total, "facet_total": facet_total, "type_counts": type_counts,
            "game_types": game_types, "stats": stats}


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
    return _inventory_stats_for_filter(session, ids, today=today, user=user)


def _inventory_stats_for_filter(
    session: Session,
    account_filter: Any,
    *,
    today: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """在数据库中聚合账号数、成本与库龄，不加载账号实体行。"""
    reference = today or date.today()
    cutoff_7 = datetime.combine(reference - timedelta(days=7), time.min)
    cutoff_30 = datetime.combine(reference - timedelta(days=30), time.min)
    stmt = select(
        func.count(Account.id),
        func.coalesce(func.sum(Account.cost_amount), Decimal("0")),
        func.coalesce(func.sum(case((Account.inventory_entry_at < cutoff_7, 1), else_=0)), 0),
        func.coalesce(func.sum(case((Account.inventory_entry_at < cutoff_30, 1), else_=0)), 0),
    ).where(Account.id.in_(account_filter), Account.inventory_status.in_(INVENTORY_STATUSES))
    scope = scope_filter(session, user)
    if scope is not None:
        stmt = stmt.where(scope)
    account_count, occupied_cost, over_7d, over_30d = session.execute(stmt).one()
    return {
        "account_count": int(account_count or 0),
        "occupied_cost": to_money(occupied_cost or Decimal("0")),
        "over_7d_count": int(over_7d or 0),
        "over_30d_count": int(over_30d or 0),
    }


def dashboard_inventory_summary(
    session: Session,
    *,
    reminder_days: int,
    today: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, int]:
    """工作台库存卡片和提醒与库存台账使用同一账号及订单范围。"""
    reference = today or date.today()
    aging_cutoff = datetime.combine(
        reference - timedelta(days=reminder_days), time.min
    )
    overdue_cutoff = datetime.combine(
        reference - timedelta(days=AGE_WARNING_MAX_DAYS), time.min
    )
    stmt = _inventory_ledger_scope(session, user).with_only_columns(
        func.count(Account.id),
        func.coalesce(
            func.sum(case((Account.inventory_entry_at < aging_cutoff, 1), else_=0)),
            0,
        ),
        func.coalesce(
            func.sum(case((Account.inventory_entry_at < overdue_cutoff, 1), else_=0)),
            0,
        ),
        maintain_column_froms=True,
    )
    account_count, aging_count, overdue_count = session.execute(stmt).one()
    return {
        "account_count": int(account_count or 0),
        "aging_count": int(aging_count or 0),
        "overdue_count": int(overdue_count or 0),
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
    "inventory_ledger",
    "inventory_stats",
    "list_accounts",
    "total_inventory_cost",
]
