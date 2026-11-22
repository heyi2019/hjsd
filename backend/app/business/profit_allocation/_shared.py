"""profit_allocation._shared：分润模块的订单范围复用。"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.security import CurrentUser
from app.domain.trade import Order


def _scoped_order(
    session: Session, order_id: int, user: CurrentUser | None = None
) -> Order:
    """分润相关订单读写必须复用订单统一的负责人范围规则。"""
    from app.shared.order_access import get_order

    return get_order(session, order_id, user)
