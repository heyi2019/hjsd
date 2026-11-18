"""工作室收支面板：明细与已入账汇总的服务端口径单点。"""
from __future__ import annotations
from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from typing import Any
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session
from app.core.security import CurrentUser
from app.domain.enums import CashflowLedgerType, CashflowSourceType, Direction
from app.domain.trade import Cashflow, Order
from app.finance.attributes import (
    MANUAL_EXCLUDED_CATEGORIES, STUDIO_EXPENSE_ATTRIBUTE, STUDIO_INCOME_ATTRIBUTE,
)
from ._shared import _apply_cashflow_filters, _attach_extra_values, _direction_sums, _flow_row

def _studio_scope() -> Any:
    """工作室运营账簿的顶层条件。"""
    return and_(
        Cashflow.ledger_type == CashflowLedgerType.STUDIO.value,
        # 订单普通资金流水（挂 order_id 但无事件/押金/划转）属订单口径，不计入工作室收支。
        Cashflow.order_id.is_(None),
        Cashflow.source_type == CashflowSourceType.MANUAL.value,
        or_(Cashflow.category.is_(None), Cashflow.category.notin_(MANUAL_EXCLUDED_CATEGORIES)),
        or_(
            and_(
                Cashflow.direction == Direction.OUT.value,
                Cashflow.accounting_attribute == STUDIO_EXPENSE_ATTRIBUTE,
            ),
            and_(
                Cashflow.direction == Direction.IN.value,
                Cashflow.accounting_attribute == STUDIO_INCOME_ATTRIBUTE,
            ),
        ),
    )


def studio_summary(
    session: Session,
    *,
    pool_ids: Iterable[int] | None = None,
    occurred_from: date | None = None,
    occurred_to: date | None = None,
    category: str | None = None,
    limit: int = 200,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """工作室收支面板：一次返回明细与已入账汇总。

    为什么单独一个函数：这面板原先在前端发两次 `/cashflows`（收入一次、支出一次），
    自己按 `source === "OTHER"` 过滤、再对当页 reduce 出收入/支出/净额。「哪些流水
    算工作室收支」是业务口径，散在组件里既会随属性调整而漂移，也吃 `limit` 截断。

    返回的 items 与 `list_cashflows` 同结构（含 source/extra_values），前端直接渲染。
    """
    visible_pool_ids = None
    if pool_ids is not None:
        visible_pool_ids = list(pool_ids)
        if user is not None and not (user.is_admin or user.owner_scope == "ALL"):
            visible_pool_ids = [pool for pool in visible_pool_ids if user.can_see_pool(pool)]
        if not visible_pool_ids:
            # 选了池但一个都无权看：给空结果，而不是放宽成全部池。
            return {
                "items": [],
                "income": Decimal("0"),
                "expense": Decimal("0"),
                "net": Decimal("0"),
                "count": 0,
            }

    common = {
        "session": session,
        "pool_ids": visible_pool_ids,
        "occurred_from": occurred_from,
        "occurred_to": occurred_to,
        "category": category,
        "user": user,
    }

    list_stmt = _apply_cashflow_filters(
        select(Cashflow, Order.order_no).outerjoin(Order, Order.id == Cashflow.order_id),
        **common,
    ).where(_studio_scope())
    rows: list[dict[str, Any]] = []
    for flow, order_no in session.execute(
        list_stmt.order_by(Cashflow.occurred_on.desc(), Cashflow.id.desc()).limit(limit)
    ).all():
        rows.append(_flow_row(flow, order_no))

    # 当前流水登记即生效，工作室汇总直接按统一口径聚合。
    totals_stmt = _apply_cashflow_filters(
        select(Cashflow.direction, func.sum(Cashflow.amount)).outerjoin(
            Order, Order.id == Cashflow.order_id
        ),
        **common,
    ).where(_studio_scope()).group_by(Cashflow.direction)
    sums = _direction_sums(session, totals_stmt)
    income = sums.get(Direction.IN.value, Decimal("0.00"))
    expense = sums.get(Direction.OUT.value, Decimal("0.00"))

    # 笔数按与明细同一套筛选条件做 SQL COUNT，不吃 items 的 limit（与 list_cashflows
    # 的 total 同范式）。不能用 len(rows)：rows 来自 .limit(limit)，会让超过上限时漏算。
    count_stmt = _apply_cashflow_filters(
        select(Cashflow.id).outerjoin(Order, Order.id == Cashflow.order_id),
        **common,
    ).where(_studio_scope())
    count = session.scalar(select(func.count()).select_from(count_stmt.subquery())) or 0

    _attach_extra_values(session, rows)

    return {
        "items": rows,
        "income": income,
        "expense": expense,
        "net": income - expense,
        "count": count,
    }
