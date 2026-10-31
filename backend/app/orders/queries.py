"""orders.queries：订单列表与计数查询（ORD-01）。
"""

from __future__ import annotations

from datetime import date
from app.core.security import CurrentUser
from app.core.security import owner_scope_filter
from app.domain.enums import EventType
from sqlalchemy import (
    exists,
    func,
    or_,
    select,
)
from sqlalchemy.orm import Session
from app.domain.trade import (
    Account,
    Order,
    OrderEvent,
)

def list_orders(
    session: Session, *, order_type: str | None = None, status: str | None = None,
    trade_date_from: date | None = None,
    trade_date_to: date | None = None,
    owner_id: int | None = None,
    pool_id: int | None = None,
    keyword: str | None = None,
    limit: int = 100,
    offset: int = 0,
    user: CurrentUser | None = None,
    mine: bool = False,
) -> list[Order]:
    stmt = _order_list_stmt(
        order_type=order_type, status=status, trade_date_from=trade_date_from,
        trade_date_to=trade_date_to, owner_id=owner_id, pool_id=pool_id,
        keyword=keyword, user=user, mine=mine, session=session,
    )
    return list(
        session.scalars(
            stmt.order_by(Order.id).limit(limit).offset(offset)
        ).unique().all()
    )


def count_orders(
    session: Session, *, order_type: str | None = None, status: str | None = None,
    trade_date_from: date | None = None, trade_date_to: date | None = None,
    owner_id: int | None = None, pool_id: int | None = None,
    keyword: str | None = None, user: CurrentUser | None = None, mine: bool = False,
) -> int:
    stmt = _order_list_stmt(
        order_type=order_type, status=status, trade_date_from=trade_date_from,
        trade_date_to=trade_date_to, owner_id=owner_id, pool_id=pool_id,
        keyword=keyword, user=user, mine=mine, session=session,
    )
    return int(session.scalar(select(func.count()).select_from(stmt.subquery())) or 0)


def _order_list_stmt(
    *, order_type: str | None, status: str | None,
    trade_date_from: date | None, trade_date_to: date | None,
    owner_id: int | None, pool_id: int | None, keyword: str | None,
    user: CurrentUser | None, mine: bool, session: Session,
):
    stmt = select(Order).outerjoin(Account, Account.id == Order.account_id)
    if order_type:
        stmt = stmt.where(Order.order_type == order_type)
    if status:
        stmt = stmt.where(Order.status == status)
    if trade_date_from is not None:
        stmt = stmt.where(Order.trade_date >= trade_date_from)
    if trade_date_to is not None:
        stmt = stmt.where(Order.trade_date <= trade_date_to)
    if owner_id is not None:
        stmt = stmt.where(Order.owner_id == owner_id)
    if pool_id is not None:
        stmt = stmt.where(
            exists(
                select(OrderEvent.id).where(
                    OrderEvent.order_id == Order.id,
                    OrderEvent.pool_id == pool_id,
                )
            )
        )
    if keyword and keyword.strip():
        pattern = f"%{keyword.strip()}%"
        stmt = stmt.where(
            or_(
                Order.order_no.ilike(pattern),
                # 2026-10-28 去冗余：平铺列已删，订单侧账号搜索走快照 JSON
                func.json_extract(Order.account_snapshot, "$.game_account").ilike(pattern),
                Account.game_account.ilike(pattern),
                Order.note.ilike(pattern),
            )
        )
    if mine and user is not None:
        stmt = stmt.where(
            or_(
                Order.owner_id == user.id,
                Order.created_by == user.username,
                exists(
                    select(OrderEvent.id).where(
                        OrderEvent.order_id == Order.id,
                        OrderEvent.event_type == EventType.SELL.value,
                        OrderEvent.created_by == user.username,
                    )
                ),
            )
        )
    elif user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    return stmt
