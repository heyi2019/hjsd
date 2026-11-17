"""stocks.router_output：库存账号列表/详情的输出装配（来源订单、扩展字段、入库操作人）。

只含只读查询与输出装配，不依赖 router 的权限注入与事务；
与 orders/router_output.py、finance/router_output.py 保持同一范式。
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import CurrentUser
from app.shared.scope import owner_scope_filter
from app.core.errors import Validation
from app.domain.trade import Account, Order
from app.domain.users import User
from app.shared.form_values import get_extra_values_bulk

from .schemas import AccountOut
from app.core.actor import actor_name as _actor

def _source_orders(
    db: Session, account_ids: list[int], user: CurrentUser | None = None
) -> dict[int, Order]:
    """读取库存账号的一对一来源订单，不按事件或时间猜测来源。"""
    if not account_ids:
        return {}
    stmt = select(Order).where(Order.account_id.in_(account_ids))
    scope = owner_scope_filter(Order.owner_id, user, db)
    if scope is not None:
        stmt = stmt.where(scope)
    orders = list(db.scalars(stmt.order_by(Order.trade_date.desc(), Order.id.desc())).all())
    if not orders:
        return {}
    result: dict[int, Order] = {}
    for order in orders:
        account_id = order.account_id
        if account_id is None:
            continue
        if account_id in result:
            raise Validation(
                "库存账号存在多个来源订单",
                details={"account_id": account_id},
            )
        result[account_id] = order
    return result


def _account_output(
    account: Account,
    source_order: Order | None = None,
    *,
    extra_values: dict[str, object] | None = None,
    inventory_operator: str | None = None,
) -> AccountOut:
    """统一补齐库存来源订单；业务与类型以标准导入的账号字段为准。"""
    output = AccountOut.model_validate(account)
    output.extra_values = extra_values or {}
    if source_order is not None:
        output.source_order_id = source_order.id
        output.source_order_no = source_order.order_no
    # 入库操作人只取建单表单中的业务操作人；创建人不属于入库操作人。
    output.inventory_operator = inventory_operator or None
    return output


def _account_outputs(
    db: Session,
    accounts: list[Account],
    user: CurrentUser | None = None,
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
    "_actor",
    "_source_orders",
    "_account_output",
    "_account_outputs",
]
