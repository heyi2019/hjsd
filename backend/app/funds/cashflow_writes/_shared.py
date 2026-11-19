"""finance.cashflow_writes._shared：流水写入共用的操作人校验与流水读取。"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.errors import NotFound
from app.core.security import CurrentUser
from app.domain.trade import Cashflow
from app.shared.order_access import get_order


def _get_cashflow(
    session: Session, cashflow_id: int, user: CurrentUser | None = None, *, for_update: bool = False
) -> Cashflow:
    if for_update:
        # 锁定原流水并刷新会话缓存，再检查冲销状态，避免并发写入基于旧快照。
        flow = session.get(Cashflow, cashflow_id, with_for_update=True, populate_existing=True)
    else:
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
