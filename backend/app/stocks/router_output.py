"""stocks.router_output：库存账号列表/详情的输出装配（来源订单、扩展字段、入库负责人）。

只含只读查询与输出装配，不依赖 router 的权限注入与事务；
与 orders/router_output.py、finance/router_output.py 保持同一范式。
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import CurrentUser, owner_scope_filter
from app.domain.trade import Account, Order, OrderEvent
from app.domain.users import User
from app.parties.fields import get_extra_values_bulk

from .schemas import AccountOut

INVENTORY_SOURCE_ORDER_TYPES = frozenset({"HS", "TH", "DG"})


def _actor(user: CurrentUser) -> str:
    return user.username


def _source_orders(
    db: Session, account_ids: list[int], user: CurrentUser | None = None
) -> dict[int, Order]:
    """解析标准订单数据中的库存来源；HS/TH/DG 均可回溯到库存实体。"""
    if not account_ids:
        return {}
    stmt = select(Order).where(Order.account_id.in_(account_ids))
    scope = owner_scope_filter(Order.owner_id, user, db)
    if scope is not None:
        stmt = stmt.where(scope)
    orders = list(db.scalars(stmt.order_by(Order.trade_date.desc(), Order.id.desc())).all())
    if not orders:
        return {}
    order_ids = [order.id for order in orders]
    buy_order_ids = set(
        db.scalars(
            select(OrderEvent.order_id).where(
                OrderEvent.order_id.in_(order_ids),
                OrderEvent.event_type == "BUY",
                OrderEvent.is_posted.is_(True),
            )
        ).all()
    )
    inventory_orders: dict[int, Order] = {}
    fallback_orders: dict[int, Order] = {}
    for order in orders:
        if order.account_id is None:
            continue
        # 已取消/未过账的来源订单没有 BUY 事件，但库存记录仍应显示其订单编号，
        # 否则详情页会出现大量“订单号 -”。正式入库订单优先使用带 BUY 的记录。
        if order.order_type in INVENTORY_SOURCE_ORDER_TYPES:
            fallback_orders.setdefault(order.account_id, order)
        if order.order_type == "DG" or (
            order.id in buy_order_ids and order.order_type in INVENTORY_SOURCE_ORDER_TYPES
        ):
            inventory_orders.setdefault(order.account_id, order)
    return {
        account_id: inventory_orders.get(account_id) or fallback_orders[account_id]
        for account_id in account_ids
        if account_id in inventory_orders or account_id in fallback_orders
    }


def _account_output(
    account: Account,
    source_order: Order | None = None,
    *,
    include_credentials: bool = False,
    extra_values: dict[str, object] | None = None,
    inventory_operator: str | None = None,
) -> AccountOut:
    """统一补齐库存来源订单；业务与类型以标准导入的账号字段为准。"""
    output = AccountOut.model_validate(account)
    if not include_credentials:
        output.game_password = None
    output.extra_values = extra_values or {}
    if source_order is not None:
        output.source_order_id = source_order.id
        output.source_order_no = source_order.order_no
    # 入库负责人优先取建单表单中的业务负责人；没有选择时回退到实际登录账号。
    output.inventory_operator = inventory_operator or account.created_by
    return output


def _account_outputs(
    db: Session,
    accounts: list[Account],
    user: CurrentUser | None = None,
    *,
    include_credentials: bool = False,
) -> list[AccountOut]:
    """批量补齐库存来源订单，避免列表逐账号查询。"""
    source_orders = _source_orders(db, [account.id for account in accounts], user)
    responsible_ids = {
        int(item)
        for order in source_orders.values()
        for item in ((order.form_extra or {}).get("business_responsible_ids") or [])
        if isinstance(item, int) and item > 0
    }
    user_names = {
        item.id: item.display_name or item.username
        for item in db.scalars(select(User).where(User.id.in_(responsible_ids))).all()
    } if responsible_ids else {}
    extra_values = get_extra_values_bulk(
        db, entity_type="account", entity_ids=[account.id for account in accounts]
    )
    return [
        _account_output(
            account,
            source_orders.get(account.id),
            include_credentials=include_credentials,
            extra_values=extra_values.get(account.id),
            inventory_operator=(
                "、".join(
                    user_names[item]
                    for item in ((source_orders.get(account.id).form_extra or {}).get("business_responsible_ids") or [])
                    if isinstance(item, int) and item in user_names
                )
                if source_orders.get(account.id) else None
            ),
        )
        for account in accounts
    ]


__all__ = [
    "INVENTORY_SOURCE_ORDER_TYPES",
    "_actor",
    "_source_orders",
    "_account_output",
    "_account_outputs",
]
