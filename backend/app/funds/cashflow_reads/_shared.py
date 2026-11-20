"""现金流查询共享基建：筛选条件、明细行结构与方向汇总。

铁律：`_apply_cashflow_filters` 是明细与合计共用的**同一份**条件，
保证合计与列表口径不漂移；拆模块时这五个 helper 必须留在同一文件。
"""
from __future__ import annotations
from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from typing import Any
from sqlalchemy import Select, func, or_
from sqlalchemy.orm import Session
from app.core.errors import Validation
from app.core.money import to_money
from app.core.security import CurrentUser
from app.shared.scope import owner_scope_filter
from app.domain.enums import CashflowLedgerType
from app.domain.trade import Cashflow, Order
from app.shared.form_values import get_extra_values_bulk
from app.shared.amount_search import amount_keyword

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
        amount = amount_keyword(keyword)
        conditions = [
            func.lower(Cashflow.flow_no).like(pattern, escape="\\"),
            func.lower(Cashflow.category).like(pattern, escape="\\"),
            func.lower(func.coalesce(Cashflow.note, "")).like(pattern, escape="\\"),
            func.lower(Order.order_no).like(pattern, escape="\\"),
        ]
        if amount is not None:
            conditions.append(Cashflow.amount == amount)
        stmt = stmt.where(
            or_(*conditions)
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
        "form_extra": flow.form_extra,
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
