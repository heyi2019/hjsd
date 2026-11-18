"""finance.cashflow_writes._shared：流水写入共用的操作人校验与流水读取。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser
from app.domain.trade import Cashflow
from app.domain.users import User
from app.shared.order_access import get_order


def _validate_operator_user_ids(
    session: Session, operator_user_ids: list[int] | None
) -> list[int] | None:
    """按订单事件/返点的口径校验资金登记操作人。"""
    if operator_user_ids is None:
        return None
    if len(set(operator_user_ids)) != len(operator_user_ids):
        raise Validation("操作人不能重复选择", details={"field": "operator_user_ids"})
    active_ids = set(
        session.scalars(
            select(User.id).where(User.id.in_(operator_user_ids), User.is_active.is_(True))
        )
    )
    if active_ids != set(operator_user_ids):
        raise Validation("所选操作人不存在或已停用", details={"field": "operator_user_ids"})
    return operator_user_ids


def _get_cashflow(
    session: Session, cashflow_id: int, user: CurrentUser | None = None
) -> Cashflow:
    flow = session.get(Cashflow, cashflow_id)
    if flow is None:
        raise NotFound(
            f"资金流水 {cashflow_id} 不存在", details={"cashflow_id": cashflow_id}
        )
    if user is not None and not user.can_see_pool(flow.pool_id):
        raise NotFound(
            f"资金流水 {cashflow_id} 不存在", details={"cashflow_id": cashflow_id}
        )
    if user is not None and flow.order_id is not None:
        get_order(session, flow.order_id, user)
    return flow
