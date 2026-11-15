"""orders.queries：订单列表与计数查询（ORD-01）。
"""

from __future__ import annotations

from datetime import date
from app.core.like_pattern import like_contains
from app.core.security import CurrentUser
from app.core.security import owner_scope_filter
from sqlalchemy import (
    cast,
    exists,
    func,
    or_,
    select,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session
from app.domain.trade import (
    Account,
    Cashflow,
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
            # 列表按「最近优先」：先交易日倒序，同日再按 id 倒序。
            # 原来是 Order.id 升序，等于把最老的 20 条排在第一页，手机端和台账都反直觉。
            stmt.order_by(Order.trade_date.desc(), Order.id.desc()).limit(limit).offset(offset)
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


def order_status_counts(
    session: Session,
    *,
    trade_date_from: date | None = None,
    trade_date_to: date | None = None,
    user: CurrentUser | None = None,
    mine: bool = False,
) -> dict[str, int]:
    """按订单状态一次聚合计数，供工作台和数据中心卡片使用。"""
    stmt = _order_list_stmt(
        order_type=None,
        status=None,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        owner_id=None,
        pool_id=None,
        keyword=None,
        user=user,
        mine=mine,
        session=session,
    ).with_only_columns(
        Order.status,
        func.count(Order.id),
        maintain_column_froms=True,
    ).group_by(Order.status)
    return {str(status): int(count) for status, count in session.execute(stmt).all()}


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
            or_(
                exists(
                    select(OrderEvent.id).where(
                        OrderEvent.order_id == Order.id,
                        OrderEvent.pool_id == pool_id,
                    )
                ),
                exists(
                    select(Cashflow.id).where(
                        Cashflow.order_id == Order.id,
                        Cashflow.pool_id == pool_id,
                    )
                ),
            )
        )
    if keyword and keyword.strip():
        pattern, escape = like_contains(keyword)
        stmt = stmt.where(
            or_(
                Order.order_no.ilike(pattern, escape=escape),
                # 2026-10-28 去冗余：平铺列已删，订单侧账号搜索走快照 JSON。
                # 必须用 ORM 的 JSON 取值表达式而非 func.json_extract：后者是 SQLite
                # 的 JSON1 扩展函数，PostgreSQL 无此函数，生产（PG）下订单关键字搜索
                # 会直接 500。as_string() 由方言各自渲染——PG 出 `->>`，SQLite 出
                # `json_extract`，两边语义一致。
                Order.account_snapshot["game_account"].as_string().ilike(pattern, escape=escape),
                Account.game_account.ilike(pattern, escape=escape),
                Order.note.ilike(pattern, escape=escape),
            )
        )
    if mine and user is not None:
        # 「我的订单」= 我负责的 + 我参与的。
        # 每一笔订单事件的执行人都算参与，不限 SELL：买号、售出、运营消耗、
        # 收付款、交付、取消、退款各自都有负责人，只认 SELL 会让买号/运营的人
        # 在自己工作台看不到他做过单。`operator_user_ids` 是事件上的多操作人，
        # 列类型是 json（不是 jsonb），PG 下必须先 cast 再用数组包含判断。
        stmt = stmt.where(
            or_(
                Order.owner_id == user.id,
                Order.created_by == user.username,
                exists(
                    select(OrderEvent.id).where(
                        OrderEvent.order_id == Order.id,
                        or_(
                            OrderEvent.created_by == user.username,
                            cast(OrderEvent.operator_user_ids, JSONB).contains([user.id]),
                        ),
                    )
                ),
            )
        )
    elif user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    return stmt
