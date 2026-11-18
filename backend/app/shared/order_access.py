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


__all__ = ["get_order"]
