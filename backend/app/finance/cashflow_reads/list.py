"""资金流水明细列表。"""
from __future__ import annotations
from collections.abc import Iterable
from datetime import date
from typing import Any
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from app.core.security import CurrentUser
from app.domain.trade import Cashflow, Order
from ._shared import _apply_cashflow_filters, _attach_extra_values, _flow_row

def list_cashflows(
    session: Session,
    *,
    pool_id: int | None = None,
    pool_ids: Iterable[int] | None = None,
    order_id: int | None = None,
    direction: str | None = None,
    occurred_from: date | None = None,
    occurred_to: date | None = None,
    ledger_type: str | None = None,
    accounting_attribute: str | None = None,
    category: str | None = None,
    created_by: str | None = None,
    keyword: str | None = None,
    limit: int = 100,
    offset: int = 0,
    user: CurrentUser | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """统一查询资金明细，直接返回订单号，避免前端按日期和金额猜来源。

    返回 (本页明细, 命中总数)；总数用于前端判断是否还有更多数据。
    关键字搜索覆盖流水号 / 类别 / 摘要 / 订单号，与本函数同一份条件（含合计）一致。
    """
    if pool_id is not None and user is not None and not user.can_see_pool(pool_id):
        return [], 0
    stmt = _apply_cashflow_filters(
        select(Cashflow, Order.order_no).outerjoin(Order, Order.id == Cashflow.order_id),
        session=session,
        pool_id=pool_id,
        pool_ids=pool_ids,
        order_id=order_id,
        direction=direction,
        occurred_from=occurred_from,
        occurred_to=occurred_to,
        ledger_type=ledger_type,
        accounting_attribute=accounting_attribute,
        category=category,
        created_by=created_by,
        keyword=keyword,
        user=user,
    )

    total = session.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows: list[dict[str, Any]] = []
    for flow, order_no in session.execute(
        stmt.order_by(Cashflow.occurred_on.desc(), Cashflow.id.desc())
        .limit(limit)
        .offset(offset)
    ).all():
        rows.append(_flow_row(flow, order_no))
    _attach_extra_values(session, rows)
    return rows, total
