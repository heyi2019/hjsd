"""工作室收支面板：明细与已入账汇总的服务端口径单点。"""
from __future__ import annotations
from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from typing import Any
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session, aliased
from app.core.security import CurrentUser
from app.domain.enums import (
    AccountingAttribute, CashflowLedgerType, CashflowSourceType, Direction,
)
from app.domain.trade import Cashflow, Order
from app.funds.attributes import (
    MANUAL_EXCLUDED_CATEGORIES, STUDIO_EXPENSE_ATTRIBUTE, STUDIO_INCOME_ATTRIBUTE,
)
from ._shared import _apply_cashflow_filters, _attach_extra_values, _direction_sums, _flow_row

def _studio_scope() -> Any:
    """工作室运营账簿的顶层条件。

    纳入两类流水（净额均为「工作室运营收支」）：
    - 手工登记：direction 与核算属性必须配对（OUT+运营支出 / IN+回收收入）；
    - 工作室流水的冲销：核算属性为 REVERSAL、账簿随原流水继承为 STUDIO，
      direction 与原流水相反。汇总时按反向方向做带符号汇总，使冲销抵消原流水。
    """
    manual = and_(
        Cashflow.source_type == CashflowSourceType.MANUAL.value,
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
    # 冲销流水：REVERSAL 属性 + REVERSAL 来源；账簿随原流水继承为 STUDIO，
    # 由调用方 reverse_cashflow 保证。业务账簿的冲销不会进入本 scope。
    reversal = and_(
        Cashflow.source_type == CashflowSourceType.REVERSAL.value,
        Cashflow.accounting_attribute == AccountingAttribute.REVERSAL.value,
    )
    return and_(
        Cashflow.ledger_type == CashflowLedgerType.STUDIO.value,
        # 订单普通资金流水（挂 order_id 但无事件/押金/划转）属订单口径，不计入工作室收支。
        Cashflow.order_id.is_(None),
        or_(Cashflow.category.is_(None), Cashflow.category.notin_(MANUAL_EXCLUDED_CATEGORIES)),
        or_(manual, reversal),
    )


def studio_summary(
    session: Session,
    *,
    pool_ids: Iterable[int] | None = None,
    occurred_from: date | None = None,
    occurred_to: date | None = None,
    category: str | None = None,
    sort_desc: bool = True,
    limit: int = 200,
    offset: int = 0,
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
        "user": user,
    }

    conditions = [_studio_scope()]
    if category is not None:
        # 冲销行的科目固定为 REVERSAL，按原流水科目筛选才能正确抵消金额。
        original = aliased(Cashflow)
        original_matches = select(original.id).where(
            original.flow_no == Cashflow.source_id,
            original.category == category,
        ).exists()
        conditions.append(or_(
            Cashflow.category == category,
            and_(Cashflow.source_type == CashflowSourceType.REVERSAL.value, original_matches),
        ))

    list_stmt = _apply_cashflow_filters(
        select(Cashflow, Order.order_no).outerjoin(Order, Order.id == Cashflow.order_id),
        **common,
    ).where(*conditions)
    rows: list[dict[str, Any]] = []
    for flow, order_no in session.execute(
        list_stmt.order_by(Cashflow.occurred_on.desc() if sort_desc else Cashflow.occurred_on.asc(), Cashflow.id.desc() if sort_desc else Cashflow.id.asc()).limit(limit).offset(offset)
    ).all():
        rows.append(_flow_row(flow, order_no))

    # 冲销流水（REVERSAL）的 direction 与原流水相反。若按 direction 直接分组，
    # 「支出冲销」会被算成收入、「收入冲销」被算成支出，净额虽归零但收入/支出两栏
    # 各自虚增。按方案 A：把冲销流水方向取反、金额取负，归到原流水方向做反向扣减，
    # 使冲销真正抵消原流水（净额、收入、支出三栏同时正确）。
    effective_direction = case(
        (
            Cashflow.source_type == CashflowSourceType.REVERSAL.value,
            case(
                (Cashflow.direction == Direction.OUT.value, Direction.IN.value),
                else_=Direction.OUT.value,
            ),
        ),
        else_=Cashflow.direction,
    )
    effective_amount = case(
        (Cashflow.source_type == CashflowSourceType.REVERSAL.value, -Cashflow.amount),
        else_=Cashflow.amount,
    )
    # 当前流水登记即生效，工作室汇总直接按统一口径聚合。
    totals_stmt = _apply_cashflow_filters(
        select(effective_direction, func.sum(effective_amount)).outerjoin(
            Order, Order.id == Cashflow.order_id
        ),
        **common,
    ).where(*conditions).group_by(effective_direction)
    sums = _direction_sums(session, totals_stmt)
    income = sums.get(Direction.IN.value, Decimal("0.00"))
    expense = sums.get(Direction.OUT.value, Decimal("0.00"))

    # 笔数按与明细同一套筛选条件做 SQL COUNT，不吃 items 的 limit（与 list_cashflows
    # 的 total 同范式）。不能用 len(rows)：rows 来自 .limit(limit)，会让超过上限时漏算。
    count_stmt = _apply_cashflow_filters(
        select(Cashflow.id).outerjoin(Order, Order.id == Cashflow.order_id),
        **common,
    ).where(*conditions)
    count = session.scalar(select(func.count()).select_from(count_stmt.subquery())) or 0

    _attach_extra_values(session, rows)

    return {
        "items": rows,
        "income": income,
        "expense": expense,
        "net": income - expense,
        "count": count,
    }
