"""finance.cashflow_writes._shared：流水写入共用的操作人校验与流水读取。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound
from app.core.security import CurrentUser
from app.domain.trade import Cashflow
from app.shared.order_access import get_order, lock_order_reference


def _get_cashflow(
    session: Session, cashflow_id: int, user: CurrentUser | None = None, *, for_update: bool = False
) -> Cashflow:
    if for_update:
        current = session.execute(
            select(Cashflow.pool_id, Cashflow.order_id).where(Cashflow.id == cashflow_id)
        ).one_or_none()
        if current is None or (user is not None and not user.can_see_pool(current.pool_id)):
            raise NotFound(f"资金流水 {cashflow_id} 不存在", details={"cashflow_id": cashflow_id})
        if current.order_id is not None:
            if user is not None:
                get_order(session, current.order_id, user)
            lock_order_reference(session, current.order_id)
        # 锁定原流水并刷新会话缓存，再检查冲销状态，避免并发写入基于旧快照。
        flow = session.get(Cashflow, cashflow_id, with_for_update=True, populate_existing=True)
        if flow is not None and flow.order_id != current.order_id:
            raise Conflict("资金流水来源订单已变化，请刷新后重试")
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
