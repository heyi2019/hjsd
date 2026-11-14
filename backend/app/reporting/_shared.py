"""reporting._shared：报表共用的期间校验、金额归集、坏账与范围过滤工具。

口径红线：账号买入及订单直接支出通过资金明细归集为直接成本，**不进运营费用**；未归集返点独立成列，不摊给业务。
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from typing import Any
from app.core.errors import Validation
from app.core.money import to_money_or_zero
from app.core.security import CurrentUser
from app.core.security import owner_scope_filter
from sqlalchemy import (
    and_,
    case,
    func,
    select,
)
from sqlalchemy.orm import Session
from app.domain.enums import Direction
from app.domain.trade import (
    Cashflow,
    Order,
)
from app.orders.amounts import (
    business_cashflow_filter,
    order_profit_flow_by_order,
)

ZERO = Decimal("0")
REPORT_NAMES = frozenset(
    {
        "monthly-pnl",
        "commission",
        "business-pnl",
        "daily-funds",
        "order-profit",
    }
)

def _validate_date_range(
    from_date: date | None, to_date: date | None
) -> None:
    if from_date is not None and to_date is not None and from_date > to_date:
        raise Validation(
            "开始日期不能晚于结束日期",
            details={"from": from_date.isoformat(), "to": to_date.isoformat()},
        )


# ----------------------------------------------- 坏账 / 期间 / 范围过滤
def _sum_report_field(items: list[dict[str, Any]], field: str) -> Decimal:
    return sum((item[field] for item in items), ZERO)


def cashflow_totals_by_order(
    session: Session,
    *,
    order_ids: Iterable[int] | None = None,
    from_date: date | None = None,
    to_date: date | None = None,
) -> dict[int, tuple[Decimal, Decimal, Decimal]]:
    """按订单汇总资金明细 (所有收入, 所有支出, 其中买号支出)。

    2026-11-05 用户裁决：利润 = 单订单所有收入 − 所有支出，可正可负可 0；
    资金走向只有收入 / 支出两种，不以「是否生成 cashflow 行」为界。
    本函数是报表侧唯一取数口，与分润基数 `order_cashflow_profit` 同源：
    不看 status / nature / fund_nature，冲销流水本身是反向流水自然计入；
    返点记录（收入）与分期坏账（支出）由 `order_profit_flow_by_order` 补齐。
    押金损失是「已占用押金转费用」的定性转换、非第二次现金流出，由
    `business_cashflow_filter` 排除，与订单利润明细 `order_cashflow_profit_by_order` 同源。
    调用方传入的 order_ids 必须已过权限范围。
    """
    ids = list(order_ids) if order_ids is not None else None
    if ids is not None and not ids:
        return {}
    income_case = case(
        (Cashflow.direction == Direction.IN.value, Cashflow.amount), else_=0
    )
    expense_case = case(
        (Cashflow.direction == Direction.OUT.value, Cashflow.amount), else_=0
    )
    buy_case = case(
        (
            and_(
                Cashflow.direction == Direction.OUT.value,
                Cashflow.category == "BUY",
            ),
            Cashflow.amount,
        ),
        else_=0,
    )
    stmt = (
        select(
            Cashflow.order_id,
            func.coalesce(func.sum(income_case), 0),
            func.coalesce(func.sum(expense_case), 0),
            func.coalesce(func.sum(buy_case), 0),
        )
        .where(Cashflow.order_id.is_not(None), business_cashflow_filter())
        .group_by(Cashflow.order_id)
    )
    if ids is not None:
        stmt = stmt.where(Cashflow.order_id.in_(ids))
    if from_date is not None:
        stmt = stmt.where(Cashflow.occurred_on >= from_date)
    if to_date is not None:
        stmt = stmt.where(Cashflow.occurred_on <= to_date)
    totals: dict[int, list[Decimal]] = {
        int(order_id): [to_money_or_zero(income), to_money_or_zero(expense), to_money_or_zero(buy)]
        for order_id, income, expense, buy in session.execute(stmt).all()
    }
    for order_id, (rebate_income, bad_debt_expense) in order_profit_flow_by_order(
        session, order_ids=ids, from_date=from_date, to_date=to_date
    ).items():
        row = totals.setdefault(order_id, [ZERO, ZERO, ZERO])
        row[0] += rebate_income
        row[1] += bad_debt_expense
    return {key: tuple(value) for key, value in totals.items()}


def _month_key(value: date) -> str:
    return f"{value.year:04d}-{value.month:02d}"


def _apply_order_scope(stmt, user: CurrentUser | None, session: Session):
    if user is None:
        return stmt
    scope = owner_scope_filter(Order.owner_id, user, session)
    return stmt.where(scope) if scope is not None else stmt


def _visible_pool_ids(user: CurrentUser | None) -> set[int] | None:
    if user is None or user.is_admin or user.owner_scope == "ALL":
        return None
    return set(user.pool_ids)
