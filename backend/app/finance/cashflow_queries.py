"""finance 现金流查询层（2026-11-18 P2 从 cashflows.py 拆出）。

职责：资金流水的统一筛选、明细列表与合计。拆分原因：cashflows.py 同时承载
写路径（登记/冲销/工作室 CRUD）与查询层，839 行超载；查询条件与写路径无共享状态，
独立成模块后两侧各自聚焦。

关键约束（搬移时原样保留，勿丢）：
- `_apply_cashflow_filters` 是明细查询与合计查询共用的**同一份**条件，
  保证合计与列表口径不漂移；
- `_flow_row` / `_attach_extra_values` 为列表与工作室面板共用结构；
- `studio_summary` 是「哪些流水算工作室收支」口径的服务端单点，
  口径常量见 `finance/attributes.py`。
"""
from __future__ import annotations

from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.core.money import to_money
from app.core.security import CurrentUser
from app.shared.scope import owner_scope_filter
from app.domain.enums import CashflowLedgerType, CashflowSourceType, Direction
from app.domain.trade import Cashflow, Order
from app.finance.attributes import (
    MANUAL_EXCLUDED_CATEGORIES,
    STUDIO_EXPENSE_ATTRIBUTE,
    STUDIO_INCOME_ATTRIBUTE,
)
from app.shared.form_values import get_extra_values_bulk


def _like_pattern(keyword: str) -> str:
    """把用户输入转成 LIKE 模式；转义 `%` 与 `_`，避免关键字被当成通配符。"""
    escaped = (
        keyword.strip()
        .lower()
        .replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    )
    return f"%{escaped}%"


def _apply_cashflow_filters(
    stmt: Select[Any],
    *,
    session: Session,
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
) -> Select[Any]:
    """把资金流水的整套筛选条件套到任意 select 上。

    要求传入的 `stmt` 已 `outerjoin(Order, Order.id == Cashflow.order_id)`：订单归属
    范围（`owner_scope_filter`）与关键字里的订单号都依赖这个 join。

    抽成公共函数的原因：明细查询与合计查询必须用**同一份**条件，否则合计会和列表
    口径漂移（这正是原先由前端各算一遍导致的隐患）。
    """
    if pool_id is not None:
        stmt = stmt.where(Cashflow.pool_id == pool_id)
    elif pool_ids is not None:
        visible_pool_ids = list(pool_ids)
        if user is not None and not (user.is_admin or user.owner_scope == "ALL"):
            visible_pool_ids = [pool for pool in visible_pool_ids if user.can_see_pool(pool)]
        stmt = stmt.where(Cashflow.pool_id.in_(visible_pool_ids))
    elif user is not None and not (user.is_admin or user.owner_scope == "ALL"):
        stmt = stmt.where(Cashflow.pool_id.in_(sorted(user.pool_ids)))
    if order_id is not None:
        stmt = stmt.where(Cashflow.order_id == order_id)
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(Cashflow.order_id.is_(None) | scope)
    if direction is not None:
        stmt = stmt.where(Cashflow.direction == direction)
    if occurred_from is not None:
        stmt = stmt.where(Cashflow.occurred_on >= occurred_from)
    if occurred_to is not None:
        stmt = stmt.where(Cashflow.occurred_on <= occurred_to)
    if nature is not None:
        stmt = stmt.where(Cashflow.nature == nature)
    if ledger_type is not None:
        try:
            ledger_type = CashflowLedgerType(ledger_type).value
        except ValueError as exc:
            raise Validation(
                f"ledger_type 必须为 {CashflowLedgerType.values()}",
                details={"field": "ledger_type", "value": ledger_type},
            ) from exc
        stmt = stmt.where(Cashflow.ledger_type == ledger_type)
    if accounting_attribute is not None:
        stmt = stmt.where(Cashflow.accounting_attribute == accounting_attribute)
    if category is not None:
        stmt = stmt.where(Cashflow.category == category)
    if created_by is not None:
        stmt = stmt.where(Cashflow.created_by == created_by)
    if keyword is not None and keyword.strip():
        pattern = _like_pattern(keyword)
        stmt = stmt.where(
            or_(
                func.lower(Cashflow.flow_no).like(pattern, escape="\\"),
                func.lower(Cashflow.category).like(pattern, escape="\\"),
                func.lower(func.coalesce(Cashflow.note, "")).like(pattern, escape="\\"),
                func.lower(Order.order_no).like(pattern, escape="\\"),
            )
        )
    return stmt


def _flow_row(flow: Cashflow, order_no: str | None) -> dict[str, Any]:
    """明细行的统一结构；列表与工作室面板共用，避免两处字段慢慢漂移。"""
    source = flow.source_type
    return {
        "id": flow.id,
        "flow_no": flow.flow_no,
        "pool_id": flow.pool_id,
        "occurred_on": flow.occurred_on,
        "occurred_at": flow.created_at,
        "nature": flow.nature,
        "ledger_type": flow.ledger_type,
        "accounting_attribute": flow.accounting_attribute,
        "category": flow.category,
        "direction": flow.direction,
        "amount": flow.amount,
        "source_type": flow.source_type,
        "source_id": flow.source_id,
        "reviewed_by": flow.reviewed_by,
        "reviewed_at": flow.reviewed_at,
        "order_id": flow.order_id,
        "order_no": order_no,
        "source": source,
        "note": flow.note,
        "operator": flow.created_by,
        "operator_user_ids": flow.operator_user_ids,
    }


def _attach_extra_values(session: Session, rows: list[dict[str, Any]]) -> None:
    """批量回填流水扩展字段；列表与工作室面板共用，避免两处逐字复制。"""
    extras = get_extra_values_bulk(
        session, entity_type="cashflow", entity_ids=[row["id"] for row in rows]
    )
    for row in rows:
        row["extra_values"] = extras.get(row["id"], {})


def _direction_sums(session: Session, stmt: Select) -> dict[str, Decimal]:
    """按资金方向汇总金额；明细合计与工作室面板共用同一兜底口径。"""
    return {
        direction_value: to_money(amount or 0)
        for direction_value, amount in session.execute(stmt).all()
    }


def list_cashflows(
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
        nature=nature,
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

    _attach_extra_values(session, rows)

    return {
        "items": rows,
        "income": income,
        "expense": expense,
        "net": income - expense,
        "count": len(rows),
    }


__all__ = ["cashflow_totals", "list_cashflows", "studio_summary"]
