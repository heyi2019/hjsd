"""reporting.r2_monthly_pnl：R2 月度经营损益。

账号 COST 属直接成本，**不进运营费用**（作图费不得使运营费用重复增加）。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any
from app.core.security import CurrentUser
from sqlalchemy import (
    or_,
    select,
)
from sqlalchemy.orm import Session
from app.domain.enums import (
    CashflowStatus,
    Direction,
    Nature,
)
from app.domain.trade import (
    Cashflow,
    Order,
    OrderEvent,
    RebateRecord,
    RebateSettlement,
)

from ._shared import (
    ZERO,
    _apply_order_scope,
    _bad_debt_rows,
    _event_contribution,
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
    """R2 月度经营损益：账号 COST 归直接成本，不进运营费用。"""
    _validate_date_range(from_date, to_date)
    events = session.scalars(
        _apply_order_scope(
            select(OrderEvent)
            .join(Order, Order.id == OrderEvent.order_id)
            .where(OrderEvent.is_posted.is_(True)),
            user,
            session,
        )
    ).all()

    revenue: dict[str, Decimal] = defaultdict(lambda: ZERO)
    direct_cost: dict[str, Decimal] = defaultdict(lambda: ZERO)
    event_types = {event.id: event.event_type for event in events}
    for event in events:
        if from_date and event.occurred_on < from_date:
            continue
        if to_date and event.occurred_on > to_date:
            continue
        key = _month_key(event.occurred_on)
        income, buy_amount, event_cost = _event_contribution(event, event_types)
        revenue[key] += income
        direct_cost[key] += buy_amount + event_cost

    for _order_id, amount, occurred_on in _bad_debt_rows(session, user=user):
        if from_date and occurred_on < from_date:
            continue
        if to_date and occurred_on > to_date:
            continue
        direct_cost[_month_key(occurred_on)] += amount

    # 运营费用只认资金属性，避免依赖自由填写的流水类别。
    op_stmt = select(Cashflow).where(
        Cashflow.status == CashflowStatus.APPROVED.value,
        Cashflow.order_event_id.is_(None),
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
        if (
            flow.direction == Direction.OUT.value
            and flow.nature == Nature.BUSINESS_OUT.value
        ):
            operating[_month_key(occurred_on)] += amount
        elif flow.reversal_of_id is not None:
            original = session.get(Cashflow, flow.reversal_of_id)
            if original is not None and (
                original.direction == Direction.OUT.value
                and original.nature == Nature.BUSINESS_OUT.value
            ):
                operating[_month_key(occurred_on)] -= amount

    rebate_stmt = (
        select(
            RebateSettlement.settled_on,
            RebateSettlement.gross_amount,
            RebateSettlement.platform_fee,
            RebateSettlement.reversal_of_id,
        )
        .join(RebateRecord, RebateRecord.id == RebateSettlement.rebate_record_id)
        .join(Order, Order.id == RebateRecord.source_order_id)
    )
    rebate_stmt = _apply_order_scope(rebate_stmt, user, session)
    rebate_rows = session.execute(rebate_stmt).all()
    rebate_income: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for settled_on, gross, fee, reversal_of_id in rebate_rows:
        if from_date and settled_on < from_date:
            continue
        if to_date and settled_on > to_date:
            continue
        sign = Decimal("-1") if reversal_of_id is not None else Decimal("1")
        rebate_income[_month_key(settled_on)] += sign * _money(gross)

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
                "rebate_income": rebate,
                "operating_profit": income - cost - op + rebate,
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
