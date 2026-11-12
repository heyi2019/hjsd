"""value_added_services.queries：分期合约列表与合计的只读查询（无写事务）。

`_apply_installment_filters` 是列表与合计**同一份**筛选条件，保证两处口径不漂移；
从 create.py 拆出后，建档写事务与只读查询各自内聚。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.core.security import CurrentUser, owner_scope_filter
from app.domain.trade import Installment, Order


def _apply_installment_filters(
    stmt,
    *,
    session: Session,
    status: str | None = None,
    order_id: int | None = None,
    contract_type: str | None = None,
    trade_date_from: date | None = None,
    trade_date_to: date | None = None,
    user: CurrentUser | None = None,
):
    """分期合约的公共筛选条件（列表与合计必须同一份，避免口径漂移）。

    调用方需已 `join(Order)`：日期区间按**订单成交日期**筛，与前端原先的本地筛选同义。
    `contract_type` 是 Installment 自身列（非 Order），面板按类型分列时列表与合计须同条件。
    """
    if status:
        stmt = stmt.where(Installment.status == status)
    if order_id:
        stmt = stmt.where(Installment.order_id == order_id)
    if contract_type:
        stmt = stmt.where(Installment.contract_type == contract_type)
    if trade_date_from is not None:
        stmt = stmt.where(Order.trade_date >= trade_date_from)
    if trade_date_to is not None:
        stmt = stmt.where(Order.trade_date <= trade_date_to)
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    return stmt


def list_installments(
    session: Session,
    *,
    status: str | None = None,
    order_id: int | None = None,
    contract_type: str | None = None,
    trade_date_from: date | None = None,
    trade_date_to: date | None = None,
    user: CurrentUser | None = None,
) -> list[Installment]:
    stmt = _apply_installment_filters(
        select(Installment).join(Order, Order.id == Installment.order_id),
        session=session,
        status=status,
        order_id=order_id,
        contract_type=contract_type,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        user=user,
    )
    return list(session.scalars(stmt.order_by(Installment.id)).all())


def installment_totals(
    session: Session,
    *,
    status: str | None = None,
    order_id: int | None = None,
    contract_type: str | None = None,
    trade_date_from: date | None = None,
    trade_date_to: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Decimal]:
    """按与列表**完全相同**的条件聚合总应收 / 已收 / 剩余（Decimal，服务端唯一口径）。

    剩余用 GREATEST(..., 0) 夹住：先收款后减免时公式会得负数，页面不能显示负的「剩余」。
    """
    receivable = (
        Installment.down_payment
        + Installment.per_period * Installment.periods
        + func.coalesce(Installment.final_period_adjustment, 0)
        - Installment.waived_amount
    )
    remaining = func.greatest(
        receivable
        - Installment.paid_amount
        - func.coalesce(Installment.bad_debt_amount, 0),
        0,
    )
    stmt = _apply_installment_filters(
        select(
            func.coalesce(func.sum(receivable), 0),
            func.coalesce(func.sum(Installment.paid_amount), 0),
            func.coalesce(func.sum(remaining), 0),
        ).join(Order, Order.id == Installment.order_id),
        session=session,
        status=status,
        order_id=order_id,
        contract_type=contract_type,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        user=user,
    )
    total_receivable, total_paid, total_remaining = session.execute(stmt).one()
    return {
        "total_receivable": to_money(total_receivable or 0),
        "total_paid": to_money(total_paid or 0),
        "total_remaining": to_money(total_remaining or 0),
    }
