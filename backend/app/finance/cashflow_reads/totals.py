"""资金流水收入/支出合计（与明细共用筛选条件）。"""
from __future__ import annotations
from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from app.core.security import CurrentUser
from app.domain.enums import Direction
from app.domain.trade import Cashflow, Order
from ._shared import _apply_cashflow_filters, _direction_sums

def cashflow_totals(
    session: Session,
    *,
    pool_id: int | None = None,
    pool_ids: Iterable[int] | None = None,
    order_id: int | None = None,
    direction: str | None = None,
    occurred_from: date | None = None,
    occurred_to: date | None = None,
    nature: str | None = None,
    ledger_type: str | None = None,
    accounting_attribute: str | None = None,
    category: str | None = None,
    created_by: str | None = None,
    keyword: str | None = None,
    user: CurrentUser | None = None,
) -> tuple[Decimal, Decimal]:
    """按与明细**完全相同**的筛选条件，返回 (收入合计, 支出合计)。

    为什么必须在服务端算：列表有 `limit` 上限（当前 2000），前端对当页求和会在流水
    超过上限时静默少算且没有任何提示；聚合走 SQL SUM 也避免前端用浮点累加金额。

    合计只汇总 `amount`，与明细列表保持一致。
    """
    if pool_id is not None and user is not None and not user.can_see_pool(pool_id):
        return Decimal("0"), Decimal("0")
    stmt = _apply_cashflow_filters(
        select(Cashflow.direction, func.sum(Cashflow.amount)).outerjoin(
            Order, Order.id == Cashflow.order_id
        ),
        session=session,
        pool_id=pool_id,
        pool_ids=pool_ids,
        order_id=order_id,
        direction=direction,
        occurred_from=occurred_from,
        occurred_to=occurred_to,
        nature=nature,
        ledger_type=ledger_type,
        accounting_attribute=accounting_attribute,
        category=category,
        created_by=created_by,
        keyword=keyword,
        user=user,
    ).group_by(Cashflow.direction)
    sums = _direction_sums(session, stmt)
    return sums.get(Direction.IN.value, Decimal("0")), sums.get(Direction.OUT.value, Decimal("0"))
