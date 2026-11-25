"""客户档案查询：列表语句、分页、计数与统计。"""
from __future__ import annotations
from datetime import date, datetime, time, timedelta
from collections.abc import Sequence
from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session
from app.core.like_pattern import like_contains
from app.core.security import CurrentUser
from app.shared.scope import owner_scope_filter, owner_scope_ids
from app.core.errors import NotFound
from app.domain.parties import Customer
from app.shared.order_access import order_customer_ids
from app.shared.user_identity import actor_names
from app.customers._common import apply_created_range

def _customer_list_stmt(
    *, keyword: str | None, status: str | None, created_by: Sequence[str] | None,
    user: CurrentUser | None, session: Session, mine_orders: bool = False,
    trade_date_from: date | None = None, trade_date_to: date | None = None,
    created_from: date | None = None, created_to: date | None = None,
):
    stmt = apply_created_range(select(Customer), Customer.created_at, created_from, created_to)
    if mine_orders:
        if user is None:
            raise ValueError("我的订单筛选需要当前用户")
        stmt = stmt.where(Customer.id.in_(order_customer_ids(
            session, trade_date_from=trade_date_from, trade_date_to=trade_date_to, user=user, mine=True,
        )))
    if status:
        stmt = stmt.where(Customer.status == status)
    if created_by:
        stmt = stmt.where(Customer.created_by.in_(actor_names(session, created_by)))
    if keyword:
        pattern, escape = like_contains(keyword)
        stmt = stmt.where(
            or_(
                Customer.display_name.like(pattern, escape=escape),
                Customer.customer_no.like(pattern, escape=escape),
                Customer.phone.like(pattern, escape=escape),
                Customer.wechat.like(pattern, escape=escape),
                Customer.qq.like(pattern, escape=escape),
            )
        )
    if user is not None:
        scope = owner_scope_filter(Customer.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    return stmt


def list_customers(
    session: Session, *, keyword: str | None = None, status: str | None = None,
    exact_name: str | None = None,
    created_by: Sequence[str] | None = None, user: CurrentUser | None = None,
    limit: int | None = None, offset: int = 0, mine_orders: bool = False, sort_desc: bool = False,
    trade_date_from: date | None = None, trade_date_to: date | None = None,
    created_from: date | None = None, created_to: date | None = None,
) -> list[Customer]:
    stmt = _customer_list_stmt(
        keyword=keyword, status=status, created_by=created_by, user=user, session=session,
        mine_orders=mine_orders, trade_date_from=trade_date_from, trade_date_to=trade_date_to,
        created_from=created_from, created_to=created_to,
    )
    if exact_name is not None:
        stmt = stmt.where(Customer.display_name == exact_name)
    if limit is not None:
        stmt = stmt.limit(limit).offset(offset)
    return list(session.scalars(stmt.order_by(Customer.created_at.desc() if sort_desc else Customer.created_at.asc(), Customer.id.desc() if sort_desc else Customer.id.asc())).all())


def count_customers(
    session: Session, *, keyword: str | None = None, status: str | None = None,
    created_by: Sequence[str] | None = None, user: CurrentUser | None = None, mine_orders: bool = False,
    trade_date_from: date | None = None, trade_date_to: date | None = None,
    created_from: date | None = None, created_to: date | None = None,
) -> int:
    stmt = _customer_list_stmt(
        keyword=keyword, status=status, created_by=created_by, user=user, session=session,
        mine_orders=mine_orders, trade_date_from=trade_date_from, trade_date_to=trade_date_to,
        created_from=created_from, created_to=created_to,
    )
    return int(session.scalar(select(func.count()).select_from(stmt.subquery())) or 0)


def summarize_customers(
    session: Session,
    *,
    today_date: date,
    keyword: str | None = None,
    status: str | None = None,
    created_by: Sequence[str] | None = None,
    user: CurrentUser | None = None,
    mine_orders: bool = False,
    trade_date_from: date | None = None,
    trade_date_to: date | None = None,
    created_from: date | None = None,
    created_to: date | None = None,
) -> dict[str, int]:
    """Summarize the same customer scope as the list, using the caller's local date."""
    month_start = today_date.replace(day=1)
    today_start = datetime.combine(today_date, time.min)
    tomorrow_start = datetime.combine(today_date + timedelta(days=1), time.min)
    month_start_at = datetime.combine(month_start, time.min)

    scope = _customer_list_stmt(
        keyword=keyword, status=status, created_by=created_by, user=user, session=session,
        mine_orders=mine_orders, trade_date_from=trade_date_from, trade_date_to=trade_date_to,
        created_from=created_from, created_to=created_to,
    ).subquery()
    created_at = scope.c.created_at
    month_count, today_count = session.execute(
        select(
            func.coalesce(
                func.sum(
                    case(
                        (
                            (created_at >= month_start_at)
                            & (created_at < tomorrow_start),
                            1,
                        ),
                        else_=0,
                    )
                ),
                0,
            ),
            func.coalesce(
                func.sum(
                    case(
                        (
                            (created_at >= today_start)
                            & (created_at < tomorrow_start),
                            1,
                        ),
                        else_=0,
                    )
                ),
                0,
            ),
        ).select_from(scope)
    ).one()

    return {
        "month_count": int(month_count),
        "today_count": int(today_count),
    }


def get_customer(session: Session, customer_id: int, user: CurrentUser | None = None, *, for_update: bool = False, key_share: bool = False) -> Customer:
    if for_update or key_share:
        stmt = select(Customer).where(Customer.id == customer_id)
        scope = owner_scope_filter(Customer.owner_id, user, session) if user is not None else None
        if scope is not None:
            stmt = stmt.where(scope)
        customer = session.scalar(
            stmt.with_for_update(read=key_share, key_share=key_share).execution_options(populate_existing=True)
        )
    else:
        customer = session.get(Customer, customer_id)
    if customer is None:
        raise NotFound(f"客户 {customer_id} 不存在", details={"customer_id": customer_id})
    if user is not None and user.owner_scope != "ALL" and not user.is_admin:
        visible_ids = owner_scope_ids(session, user)
        if customer.owner_id not in (visible_ids or set()):
            raise NotFound(f"客户 {customer_id} 不存在", details={"customer_id": customer_id})
    return customer
