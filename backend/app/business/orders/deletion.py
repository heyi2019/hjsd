"""订单凭证保留：拒绝历史物理删除入口。"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.core.security import CurrentUser
from app.shared.order_access import get_order


def delete_order(
    session: Session,
    order_id: int,
    *,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
) -> None:
    """校验可见性后拒绝删除；业务更正走取消或冲销。"""
    get_order(session, order_id, user)
    raise Validation("订单凭证不可删除，请使用取消或冲销更正")
