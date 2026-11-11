"""reporting.r2_monthly_pnl：R2 月度经营损益。

订单贡献口径（2026-11-05 用户裁决）：销售收入 / 直接成本按各订单
「所有收入 − 所有支出」取数，与订单利润明细、R5、分润基数同源。
资金走向只有收入 / 支出两种：返点记录是收入、分期坏账是支出，即使不生成
资金流水也按各自发生日归月计入。返点收益列是「其中返点」的展示项，
已含在销售收入里，不重复加进经营利润；运营费用仍是期间调整项，独立成列。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any
from app.core.security import CurrentUser
from sqlalchemy import (
    case,
    func,
    or_,
    select,
)
from sqlalchemy.orm import Session
from app.domain.enums import (
    AccountingAttribute,
    CashflowStatus,
    Direction,
    Nature,
)
from app.domain.trade import (
    Cashflow,
    Order,
)
from app.orders.amounts import order_profit_flow_by_date

from ._shared import (
    ZERO,
    _apply_order_scope,
    _money,
    _month_key,
    _sum_report_field,
    _validate_date_range,
    _visible_pool_ids,
)

def r2_monthly_pnl(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """R2 月度经营损益：订单收支按资金明细，期间费用/返点单列。"""
    _validate_date_range(from_date, to_date)
    revenue: dict[str, Decimal] = defaultdict(lambda: ZERO)
    direct_cost: dict[str, Decimal] = defaultdict(lambda: ZERO)

    # 订单资金明细：只认挂在订单上的流水，一次性按发生日分组求和。
    income_case = case(
        (Cashflow.direction == Direction.IN.value, Cashflow.amount), else_=0
    )
    expense_case = case(
        (Cashflow.direction == Direction.OUT.value, Cashflow.amount), else_=0
    )
    cf_stmt = (
        select(
            Cashflow.occurred_on,
            func.coalesce(func.sum(income_case), 0),
            func.coalesce(func.sum(expense_case), 0),
        )
        .join(Order, Order.id == Cashflow.order_id)
        .group_by(Cashflow.occurred_on)
    )
    if from_date is not None:
        cf_stmt = cf_stmt.where(Cashflow.occurred_on >= from_date)
    if to_date is not None:
        cf_stmt = cf_stmt.where(Cashflow.occurred_on <= to_date)
    cf_stmt = _apply_order_scope(cf_stmt, user, session)
    for occurred_on, income, expense in session.execute(cf_stmt).all():
        key = _month_key(occurred_on)
        revenue[key] += _money(income)
        direct_cost[key] += _money(expense)

    # 不生成资金流水、但有明确资金走向的事实：返点记录=收入，分期坏账=支出。
    # 与订单利润明细同源，按各自发生日归月；返点收益列只作「其中项」展示。
    scoped_order_ids = list(
        session.scalars(_apply_order_scope(select(Order.id), user, session)).all()
    )
    rebate_income: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for occurred_on, (extra_income, extra_expense) in order_profit_flow_by_date(
        session,
        order_ids=scoped_order_ids,
        from_date=from_date,
        to_date=to_date,
    ).items():
        key = _month_key(occurred_on)
        revenue[key] += extra_income
        direct_cost[key] += extra_expense
        rebate_income[key] += extra_income

    # 运营费用只认资金属性，避免依赖自由填写的流水类别。
    op_stmt = select(Cashflow).where(
        Cashflow.status == CashflowStatus.APPROVED.value,
        Cashflow.order_event_id.is_(None),
        # 挂订单的支出归该单「支出大类」（直接成本），不再重复进期间运营费用。
        Cashflow.order_id.is_(None),
        or_(Cashflow.fund_nature == "BUSINESS", Cashflow.category == "OPERATING_COST"),
        or_(
            Cashflow.accounting_attribute == "OPERATING_EXPENSE",
            Cashflow.accounting_attribute == "REVERSAL",
            Cashflow.category == "OPERATING_COST",
        ),
    )
    pool_ids = _visible_pool_ids(user)
    if pool_ids is not None:
        op_stmt = op_stmt.where(Cashflow.pool_id.in_(pool_ids))
    op_rows = session.scalars(op_stmt).all()
    operating: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for flow in op_rows:
        occurred_on = flow.occurred_on
        if from_date and occurred_on < from_date:
            continue
        if to_date and occurred_on > to_date:
            continue
        amount = _money(flow.amount)
        if flow.reversal_of_id is not None:
            # 冲销流水先按「被冲销的原流水」归类，不能看冲销流水自身的方向 / 性质：
            # 冲销经营收入会生成 OUT/BUSINESS_OUT，按自身方向判断会被误记成运营费用。
            # 只有原流水确属运营费用（核算属性 / 类别），才冲减运营费用列。
            original = session.get(Cashflow, flow.reversal_of_id)
            if original is not None and (
                original.accounting_attribute == AccountingAttribute.OPERATING_EXPENSE.value
                or original.category == "OPERATING_COST"
            ):
                operating[_month_key(occurred_on)] -= amount
        elif (
            flow.direction == Direction.OUT.value
            and flow.nature == Nature.BUSINESS_OUT.value
        ):
            operating[_month_key(occurred_on)] += amount

    for bucket in (revenue, direct_cost, operating, rebate_income):
        for month in list(bucket):
            if bucket[month] == ZERO:
                del bucket[month]
    months = sorted(set(revenue) | set(direct_cost) | set(operating) | set(rebate_income))
    items = []
    for month in months:
        income = revenue[month]
        cost = direct_cost[month]
        op = operating[month]
        rebate = rebate_income[month]
        items.append(
            {
                "month": month,
                "sales_income": income,
                "account_direct_cost": cost,
                "operating_expense": op,
                # 返点收入已计入 sales_income，此处只作其中项展示，不重复加回利润。
                "rebate_income": rebate,
                "operating_profit": income - cost - op,
            }
        )
    return {
        "items": items,
        "total": {
            "sales_income": _sum_report_field(items, "sales_income"),
            "account_direct_cost": _sum_report_field(items, "account_direct_cost"),
            "operating_expense": _sum_report_field(items, "operating_expense"),
            "rebate_income": _sum_report_field(items, "rebate_income"),
            "operating_profit": _sum_report_field(items, "operating_profit"),
        },
    }


# --------------------------------------------------------------------- R3 提成
