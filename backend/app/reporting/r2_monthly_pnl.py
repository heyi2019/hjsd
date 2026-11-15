"""月度经营损益。

订单贡献口径（2026-11-05 用户裁决）：销售收入 / 成本按各订单
「所有收入 − 所有支出」取数，与订单利润明细、业务级损益、分润基数同源。
资金走向只有收入 / 支出两种：返点记录是收入、分期坏账是支出，即使不生成
资金流水也按各自发生日归月计入。返点收益列是「其中返点」的展示项，
已含在销售收入里，不重复加进经营利润；该列独立聚合 RebateRecord
（与利润明细同源），不复用会跳过新模型返点的 order_profit_flow_by_date。
运营费用仍是期间调整项，独立成列。
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
    RebateStatus,
)
from app.domain.trade import (
    Cashflow,
    Order,
    RebateRecord,
)
from app.orders.amounts import business_cashflow_filter, order_profit_flow_by_date

from app.core.money import to_money_or_zero
from ._shared import (
    ZERO,
    _apply_order_scope,
    _month_key,
    _sum_report_field,
    _validate_date_range,
    _visible_pool_ids,
)

def r2_monthly_pnl(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """月度经营损益：订单收支按资金明细，期间费用/返点单列。"""
    _validate_date_range(from_date, to_date)
    revenue: dict[str, Decimal] = defaultdict(lambda: ZERO)
    cost: dict[str, Decimal] = defaultdict(lambda: ZERO)

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
        # 2026-11-12 用户裁决 C：押金完整走业务口径，与订单利润逐笔同源。
        # 套用 business_cashflow_filter：押金占用(OUT/DEPOSIT_HOLD)计入该单直接
        # 成本、释放/取消(IN)计入收入；押金损失(OUT/DEPOSIT+非HOLD)是已占用押金
        # 的定性转换、非第二次现金流出，被排除；押金线只有一套逻辑：净额=收入−支出，
        # 正为利润、负为损失（损失=−利润），不另记第二笔。推翻旧 #9「挂单押金一律剔除」。
        .where(business_cashflow_filter())
        .group_by(Cashflow.occurred_on)
    )
    if from_date is not None:
        cf_stmt = cf_stmt.where(Cashflow.occurred_on >= from_date)
    if to_date is not None:
        cf_stmt = cf_stmt.where(Cashflow.occurred_on <= to_date)
    cf_stmt = _apply_order_scope(cf_stmt, user, session)
    for occurred_on, income, expense in session.execute(cf_stmt).all():
        key = _month_key(occurred_on)
        revenue[key] += to_money_or_zero(income)
        cost[key] += to_money_or_zero(expense)

    # 不生成资金流水、但有明确资金走向的事实：返点记录=收入，分期坏账=支出。
    # 与订单利润明细同源，按各自发生日归月；返点收益列只作「其中项」展示。
    scoped_order_ids = list(
        session.scalars(_apply_order_scope(select(Order.id), user, session)).all()
    )
    # 收入/支出大类继续走 order_profit_flow_by_date：新模型返点在这条线的收入
    # 已由资金流水计入 revenue，坏账计入 cost，口径不变。
    for occurred_on, (extra_income, extra_expense) in order_profit_flow_by_date(
        session,
        order_ids=scoped_order_ids,
        from_date=from_date,
        to_date=to_date,
    ).items():
        key = _month_key(occurred_on)
        revenue[key] += extra_income
        cost[key] += extra_expense

    # 「其中返点」列独立聚合 RebateRecord（与利润明细 profit.py 同源）：
    # 不能复用 order_profit_flow_by_date 的 extra_income——那个函数对「已生成资金流水
    # 的新模型返点」做了 continue 防重复计收入，连带把它的「其中项展示」也跳过了，
    # 导致同一笔新模型返点在月度损益列=0、利润明细列=amount 的口径打架。
    # 本列只作展示、不参与经营利润（operating_profit 不含它），故独立 sum 不会重复加回。
    rebate_income: dict[str, Decimal] = defaultdict(lambda: ZERO)
    if scoped_order_ids:
        rebate_rows = session.execute(
            select(RebateRecord.collected_on, RebateRecord.amount)
            .where(
                RebateRecord.source_order_id.in_(scoped_order_ids),
                RebateRecord.status != RebateStatus.VOID.value,
            )
        ).all()
        for occurred_on, amount in rebate_rows:
            if from_date and occurred_on < from_date:
                continue
            if to_date and occurred_on > to_date:
                continue
            rebate_income[_month_key(occurred_on)] += to_money_or_zero(amount)

    # 运营费用只认资金属性，避免依赖自由填写的流水类别。
    op_stmt = select(Cashflow).where(
        Cashflow.status == CashflowStatus.APPROVED.value,
        Cashflow.order_event_id.is_(None),
        # 挂订单的支出归该单「支出大类」（成本），不再重复进期间运营费用。
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
    reversal_ids = {flow.reversal_of_id for flow in op_rows if flow.reversal_of_id is not None}
    original_flows = {
        flow.id: flow
        for flow in session.scalars(select(Cashflow).where(Cashflow.id.in_(reversal_ids))).all()
    } if reversal_ids else {}
    operating: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for flow in op_rows:
        occurred_on = flow.occurred_on
        if from_date and occurred_on < from_date:
            continue
        if to_date and occurred_on > to_date:
            continue
        amount = to_money_or_zero(flow.amount)
        if flow.reversal_of_id is not None:
            # 冲销流水先按「被冲销的原流水」归类，不能看冲销流水自身的方向 / 性质：
            # 冲销经营收入会生成 OUT/BUSINESS_OUT，按自身方向判断会被误记成运营费用。
            # 只有原流水确属运营费用（核算属性 / 类别），才冲减运营费用列。
            original = original_flows.get(flow.reversal_of_id)
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

    for bucket in (revenue, cost, operating, rebate_income):
        for month in list(bucket):
            if bucket[month] == ZERO:
                del bucket[month]
    months = sorted(set(revenue) | set(cost) | set(operating) | set(rebate_income))
    items = []
    for month in months:
        income = revenue[month]
        month_cost = cost[month]
        op = operating[month]
        rebate = rebate_income[month]
        items.append(
            {
                "month": month,
                "sales_income": income,
                "cost": month_cost,
                "operating_expense": op,
                # 返点收入已计入 sales_income，此处只作其中项展示，不重复加回利润。
                "rebate_income": rebate,
                "operating_profit": income - month_cost - op,
            }
        )
    return {
        "items": items,
        "total": {
            "sales_income": _sum_report_field(items, "sales_income"),
            "cost": _sum_report_field(items, "cost"),
            "operating_expense": _sum_report_field(items, "operating_expense"),
            "rebate_income": _sum_report_field(items, "rebate_income"),
            "operating_profit": _sum_report_field(items, "operating_profit"),
        },
    }


# --------------------------------------------------------------------- 运营费用
