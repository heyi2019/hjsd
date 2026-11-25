"""shared.order_access：带负责人范围校验的订单读取（跨域共享原语）。

原在 `app/orders/_shared.py::get_order`，被 orders / finance / policy /
installments 四个域直接引用。放在 orders 下导致 policy 反向依赖 orders
（形成 `orders ↔ policy` 双向环）。

归位理由（满足 shared 层三条判据）：
1. 被 ≥2 个业务域直接引用；
2. 自身不属于任何单一域——它只是「按当前用户可见范围读取订单」；
3. 只依赖 core（CurrentUser / owner_scope_ids / NotFound）与 domain（Order ORM）。

**口径不变**：可见性判定仍是 owner_scope + is_admin，与迁移前逐字一致。
本模块只读不写，不产生任何业务单据。
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import NotFound
from app.core.security import CurrentUser
from app.shared.scope import owner_scope_ids
from app.domain.trade import Order


def get_order(session: Session, order_id: int, user: CurrentUser | None = None) -> Order:
    """按 ID 读取订单，并校验当前用户对其的可见范围。

    不可见时抛 NotFound（不暴露「存在但无权查看」）。
    """
    order = session.get(Order, order_id)
    if order is None:
        raise NotFound(f"订单 {order_id} 不存在", details={"order_id": order_id})
    if user is not None and user.owner_scope != "ALL" and not user.is_admin:
        visible_ids = owner_scope_ids(session, user)
        if order.owner_id not in (visible_ids or set()):
            raise NotFound(f"订单 {order_id} 不存在", details={"order_id": order_id})
    return order


def lock_order_reference(session: Session, order_id: int) -> None:
    """在修改关联记录前锁住订单引用，与订单日期平移保持一致的锁顺序。"""
    found = session.execute(
        select(Order.id).where(Order.id == order_id).with_for_update(read=True, key_share=True)
    ).scalar_one_or_none()
    if found is None:
        raise NotFound(f"订单 {order_id} 不存在", details={"order_id": order_id})


# 订单关联客户去重查询：实现依赖 orders 的列表过滤口径（_order_list_stmt /
# _mine_order_condition），口径必须保持单一权威留在 orders，故用注册点转发，
# 让 customers 只读访问共享原语、不反向依赖 orders。
_order_customer_ids_loader: Callable[..., Any] | None = None


def register_order_customer_ids(loader: Callable[..., Any]) -> None:
    """由 orders 域注册「订单关联客户 ID 查询」实现（模块加载时调用）。"""
    global _order_customer_ids_loader
    _order_customer_ids_loader = loader


def order_customer_ids(*args: Any, **kwargs: Any) -> Any:
    """按当前可见订单范围返回关联客户 ID 查询（转发给 orders 注册的实现）。

    未注册即抛错：客户列表「我的订单」筛选若静默退化成不过滤，会串出无权限
    数据，必须 fail-fast。生产由 api 挂载 orders_router、测试由 conftest
    模块级 import create_app 保证 orders 模块已加载并注册。
    """
    if _order_customer_ids_loader is None:
        raise RuntimeError(
            "订单关联客户查询未注册：business/orders/queries 未被加载（注册点 app.shared.order_access）"
        )
    return _order_customer_ids_loader(*args, **kwargs)


__all__ = [
    "get_order",
    "lock_order_reference",
    "register_order_customer_ids",
    "order_customer_ids",
]
