"""库存凭证保留：拒绝历史物理删除入口。"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.core.security import CurrentUser

from .profile import get_account


def delete_inventory(
    session: Session,
    inventory_id: int,
    *,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
) -> None:
    """校验可见性后拒绝删除；关联订单可通过业务取消处理。"""
    get_account(session, inventory_id, user)
    raise Validation("库存凭证不可删除，请通过关联订单的取消操作更正")
