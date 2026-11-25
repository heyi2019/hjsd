"""orders.queries：订单列表与计数查询（ORD-01）。
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from app.core.like_pattern import like_contains
from app.core.security import CurrentUser
from app.domain.enums import OrderStatus
from app.shared.scope import owner_scope_filter
from app.shared.game_references import matching_game_references
from sqlalchemy import (
    case,
    cast,
    exists,
    func,
    Numeric,
    or_,
    select,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session, aliased
from app.domain.parties import Counterparty, Customer, OrderCounterpartyRole, OrderCustomerRole
from app.domain.trade import (
    Account,
    Cashflow,
    Order,
    OrderEvent,
)
from app.shared.amount_search import amount_keyword

def list_orders(
    session: Session, *, order_type: str | None = None, status: str | None = None,
    trade_date_from: date | None = None,
    trade_date_to: date | None = None,
    owner_id: int | None = None,
    pool_id: int | None = None,
    keyword: str | None = None,
    inventory_operator_ids: list[int] | None = None,
    sale_operator_ids: list[int] | None = None,
    business_mode: str | None = None,
    game_type: str | None = None,
    account_status: str | None = None,
    sort_desc: bool | None = None,
    limit: int | None = 100,
    offset: int = 0,
    user: CurrentUser | None = None,
    mine: bool = False,
) -> list[Order]:
    stmt = _order_list_stmt(
        order_type=order_type, status=status, trade_date_from=trade_date_from,
        trade_date_to=trade_date_to, owner_id=owner_id, pool_id=pool_id,
        keyword=keyword, inventory_operator_ids=inventory_operator_ids,
        sale_operator_ids=sale_operator_ids, business_mode=business_mode, game_type=game_type,
        account_status=account_status, user=user, mine=mine, session=session,
    )
    ordering = (
        (Order.id.desc(),) if sort_desc is True
        else (Order.id.asc(),) if sort_desc is False
        else (Order.trade_date.desc(), Order.id.desc())
    )
    return list(
        session.scalars(
            stmt.order_by(*ordering).limit(limit).offset(offset)
        ).unique().all()
    )


def count_orders(
    session: Session, *, order_type: str | None = None, status: str | None = None,
    trade_date_from: date | None = None, trade_date_to: date | None = None,
    owner_id: int | None = None, pool_id: int | None = None,
    keyword: str | None = None, inventory_operator_ids: list[int] | None = None,
    sale_operator_ids: list[int] | None = None, business_mode: str | None = None,
    game_type: str | None = None, account_status: str | None = None,
    user: CurrentUser | None = None, mine: bool = False,
) -> int:
    stmt = _order_list_stmt(
        order_type=order_type, status=status, trade_date_from=trade_date_from,
        trade_date_to=trade_date_to, owner_id=owner_id, pool_id=pool_id,
        keyword=keyword, inventory_operator_ids=inventory_operator_ids,
        sale_operator_ids=sale_operator_ids, business_mode=business_mode, game_type=game_type,
        account_status=account_status, user=user, mine=mine, session=session,
    )
    return int(session.scalar(select(func.count()).select_from(stmt.subquery())) or 0)


def order_customer_ids(
    session: Session,
    *,
    trade_date_from: date | None = None,
    trade_date_to: date | None = None,
    user: CurrentUser | None = None,
    mine: bool = False,
):
    """订单关联客户的去重查询，供工作台和客户列表共用。"""
    order_stmt = _order_list_stmt(
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
    ).with_only_columns(Order.id, maintain_column_froms=True).subquery()
    return (
        select(OrderCustomerRole.customer_id).distinct()
        .select_from(OrderCustomerRole)
        .join(order_stmt, order_stmt.c.id == OrderCustomerRole.order_id)
    )


def order_customer_count(
    session: Session, *, trade_date_from: date | None = None, trade_date_to: date | None = None,
    user: CurrentUser | None = None, mine: bool = False,
) -> int:
    stmt = select(func.count(Customer.id)).where(Customer.id.in_(order_customer_ids(
        session, trade_date_from=trade_date_from, trade_date_to=trade_date_to, user=user, mine=mine,
    )))
    if user is not None:
        scope = owner_scope_filter(Customer.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    return int(session.scalar(stmt) or 0)


def order_status_counts(
    session: Session,
    *,
    trade_date_from: date | None = None,
    trade_date_to: date | None = None,
    user: CurrentUser | None = None,
    mine: bool = False,
) -> dict[str, int]:
    """按订单状态一次聚合计数，供数据中心等使用。"""
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


def workbench_order_counts(
    session: Session,
    *,
    trade_date_from: date | None = None,
    trade_date_to: date | None = None,
    user: CurrentUser,
) -> tuple[int, int]:
    """同一次订单聚合分别计算可见总量和本人操作量。"""
    scope = owner_scope_filter(Order.owner_id, user, session)
    visible_count = func.count(Order.id)
    if scope is not None:
        visible_count = visible_count.filter(scope)
    stmt = _order_list_stmt(
        order_type=None,
        status=None,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        owner_id=None,
        pool_id=None,
        keyword=None,
        user=None,
        mine=False,
        session=session,
    ).with_only_columns(
        visible_count,
        func.count(Order.id).filter(_mine_order_condition(user.id)),
        maintain_column_froms=True,
    )
    total, personal = session.execute(stmt).one()
    return int(total), int(personal)


def order_ledger_summary(
    session: Session,
    *,
    order_type: str | None = None,
    business_mode: str | None = None,
    game_type: str | None = None,
    account_status: str | None = None,
    keyword: str | None = None,
    inventory_operator_ids: list[int] | None = None,
    sale_operator_ids: list[int] | None = None,
    trade_date_from: date | None = None,
    trade_date_to: date | None = None,
    user: CurrentUser | None = None,
    mine: bool = False,
) -> dict[str, object]:
    """Aggregate ledger status cards and business-type counts under active filters."""
    stmt = _order_list_stmt(
        order_type=None,
        status=None,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        owner_id=None,
        pool_id=None,
        keyword=keyword,
        inventory_operator_ids=inventory_operator_ids,
        sale_operator_ids=sale_operator_ids,
        business_mode=business_mode,
        game_type=game_type,
        account_status=account_status,
        user=user,
        mine=mine,
        session=session,
    ).with_only_columns(
        Order.order_type,
        Order.status,
        func.count(Order.id),
        maintain_column_froms=True,
    ).group_by(Order.order_type, Order.status)

    type_counts: dict[str, int] = {}
    status_counts: dict[str, int] = {}
    for business_type, status, count in session.execute(stmt).all():
        count = int(count)
        type_counts[str(business_type)] = type_counts.get(str(business_type), 0) + count
        if order_type is None or business_type == order_type:
            status_counts[str(status)] = status_counts.get(str(status), 0) + count
    return {
        "total_count": sum(status_counts.values()),
        "in_progress_count": status_counts.get("ACTIVE", 0) + status_counts.get("INSTALLMENT", 0),
        "completed_count": status_counts.get("COMPLETED", 0),
        "cancelled_count": status_counts.get("CANCELLED", 0),
        "type_total": sum(type_counts.values()),
        "status_counts": status_counts,
        "type_counts": type_counts,
        "game_types": _visible_game_types(session, user=user, mine=mine),
    }


def _visible_game_types(session: Session, *, user: CurrentUser | None, mine: bool) -> list[str]:
    game_type = func.coalesce(Account.game_type, Order.account_snapshot["game_type"].as_string())
    stmt = _order_list_stmt(
        order_type=None,
        status=None,
        trade_date_from=None,
        trade_date_to=None,
        owner_id=None,
        pool_id=None,
        keyword=None,
        user=user,
        mine=mine,
        session=session,
    ).with_only_columns(game_type, maintain_column_froms=True).where(game_type.is_not(None)).distinct()
    return list(session.scalars(stmt.order_by(game_type)).all())


def _latest_sale_operator_matches(operator_ids: list[int]):
    """与订单台账展示一致：回收/提号按事件编号，其余按发生日期取最近售出。"""
    sale = aliased(OrderEvent)
    latest_sale_id = (
        select(sale.id)
        .where(sale.order_id == Order.id, sale.event_type == "SELL", sale.is_posted.is_(True))
        .order_by(
            case((Order.order_type.in_(("HS", "TH")), None), else_=sale.occurred_on).desc(),
            sale.id.desc(),
        )
        .limit(1)
        .correlate(Order)
        .scalar_subquery()
    )
    return exists(
        select(OrderEvent.id).where(
            OrderEvent.order_id == Order.id,
            OrderEvent.id == latest_sale_id,
            or_(*(cast(OrderEvent.operator_user_ids, JSONB).contains([operator_id]) for operator_id in operator_ids)),
        )
    )


def _mine_order_condition(user_id: int):
    return or_(
        cast(Order.form_extra, JSONB).contains({"business_responsible_ids": [user_id]}),
        _latest_sale_operator_matches([user_id]),
    )


def _order_price_matches(amount: Decimal):
    """买入事件和列表显示的售出金额，均在分页前匹配。"""
    buy_match = exists(select(OrderEvent.id).where(
        OrderEvent.order_id == Order.id, OrderEvent.event_type == "BUY",
        OrderEvent.is_posted.is_(True), OrderEvent.amount == amount,
    ))
    last_sale = (
        select(OrderEvent.amount)
        .where(OrderEvent.order_id == Order.id, OrderEvent.event_type == "SELL", OrderEvent.is_posted.is_(True))
        .order_by(OrderEvent.id.desc()).limit(1).correlate(Order).scalar_subquery()
    )
    recorded_amount = OrderEvent.form_extra["sale_amount"].as_string()
    valid_amount = recorded_amount.op("~")(r"^[+]?[0-9]{1,16}(\.[0-9]+)?$")
    recorded_sum = func.sum(case((valid_amount, func.round(cast(recorded_amount, Numeric), 2)), else_=None))
    consignment_sale = (
        select(func.coalesce(recorded_sum, func.sum(OrderEvent.amount)))
        .where(OrderEvent.order_id == Order.id, OrderEvent.event_type == "SELL", OrderEvent.is_posted.is_(True))
        .correlate(Order).scalar_subquery()
    )
    summed_sale = (
        select(func.sum(OrderEvent.amount))
        .where(OrderEvent.order_id == Order.id, OrderEvent.event_type == "SELL", OrderEvent.is_posted.is_(True))
        .correlate(Order).scalar_subquery()
    )
    sale_amount = case(
        (Order.order_type.in_(("HS", "TH")), last_sale),
        (Order.order_type == "DG", consignment_sale),
        else_=summed_sale,
    )
    return or_(buy_match, sale_amount == amount)


def _order_list_stmt(
    *, order_type: str | None, status: str | None,
    trade_date_from: date | None, trade_date_to: date | None,
    owner_id: int | None, pool_id: int | None, keyword: str | None,
    inventory_operator_ids: list[int] | None = None,
    sale_operator_ids: list[int] | None = None,
    business_mode: str | None = None, game_type: str | None = None,
    account_status: str | None = None,
    user: CurrentUser | None, mine: bool, session: Session,
):
    stmt = select(Order).outerjoin(Account, Account.id == Order.account_id)
    if order_type:
        stmt = stmt.where(Order.order_type == order_type)
    if status == "IN_PROGRESS":
        stmt = stmt.where(Order.status.in_((OrderStatus.ACTIVE.value, OrderStatus.INSTALLMENT.value)))
    elif status:
        stmt = stmt.where(Order.status == status)
    if trade_date_from is not None:
        stmt = stmt.where(Order.trade_date >= trade_date_from)
    if trade_date_to is not None:
        stmt = stmt.where(Order.trade_date <= trade_date_to)
    if business_mode:
        stmt = stmt.where(
            or_(Order.business_mode == business_mode, Account.business_mode == business_mode)
        )
    if game_type:
        stmt = stmt.where(
            func.coalesce(Account.game_type, Order.account_snapshot["game_type"].as_string()) == game_type
        )
    if account_status:
        stmt = stmt.where(Account.status == account_status)
    if inventory_operator_ids:
        stmt = stmt.where(or_(*(
            cast(Order.form_extra, JSONB).contains({"business_responsible_ids": [operator_id]})
            for operator_id in inventory_operator_ids
        )))
    if sale_operator_ids:
        stmt = stmt.where(_latest_sale_operator_matches(sale_operator_ids))
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
        amount = amount_keyword(keyword)
        matching_games, matching_channels = matching_game_references(session, keyword)
        stmt = stmt.where(
            or_(
                Order.order_no.ilike(pattern, escape=escape),
                func.coalesce(Account.game_type, Order.account_snapshot["game_type"].as_string()).ilike(pattern, escape=escape),
                Order.account_snapshot["game_account"].as_string().ilike(pattern, escape=escape),
                Account.game_account.ilike(pattern, escape=escape),
                Order.account_snapshot["channel_region"].as_string().ilike(pattern, escape=escape),
                Order.account_snapshot["game_type_label"].as_string().ilike(pattern, escape=escape),
                Order.account_snapshot["channel_region_label"].as_string().ilike(pattern, escape=escape),
                Account.channel_region.ilike(pattern, escape=escape),
                func.coalesce(Account.game_type, Order.account_snapshot["game_type"].as_string()).in_(matching_games),
                func.coalesce(Account.channel_region, Order.account_snapshot["channel_region"].as_string()).in_(matching_channels),
                Order.note.ilike(pattern, escape=escape),
                exists(
                    select(OrderCustomerRole.id)
                    .join(Customer, Customer.id == OrderCustomerRole.customer_id)
                    .where(
                        OrderCustomerRole.order_id == Order.id,
                        or_(Customer.display_name.ilike(pattern, escape=escape), Customer.source.ilike(pattern, escape=escape)),
                    )
                ),
                exists(
                    select(OrderCounterpartyRole.id)
                    .join(Counterparty, Counterparty.id == OrderCounterpartyRole.counterparty_id)
                    .where(
                        OrderCounterpartyRole.order_id == Order.id,
                        or_(Counterparty.display_name.ilike(pattern, escape=escape), Counterparty.source.ilike(pattern, escape=escape)),
                    )
                ),
                *([_order_price_matches(amount)] if amount is not None else []),
            )
        )
    if mine and user is not None:
        # 「我的订单」= 入库操作人是我，或出库/售出操作人是我。
        # 两个条件都是针对同一订单的 OR；同一订单同时命中两边也只返回一行。
        stmt = stmt.where(_mine_order_condition(user.id))
    elif user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    return stmt
