"""业务级损益。

主营利润口径（2026-11-05 用户裁决）：按业务类型汇总各订单
「所有收入 − 所有支出」，与订单利润明细 / 分润基数同源。
资金走向只有收入 / 支出两种：返点记录计入收入、分期坏账计入支出，
两者即使不生成资金流水也进主营利润。

结算展示层与模型层均已下线（11-05 二次裁决）：`rebate_settlements` 表 /
ORM / 编号器移除，「已结算返点 / 未归集返点 / 完整收益」三列和
`基数 × 费率%` 派生算法全部移除；返点金额全站唯一取 `rebate_records.amount`。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any
from app.core.security import CurrentUser
from app.settings.field_definitions.classification import classification_for_order_type
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.domain.trade import Order

from .._shared import (
    ZERO,
    _apply_order_scope,
    _sum_report_field,
    _validate_date_range,
    cashflow_totals_by_order,
)

def business_pnl_report(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """业务级损益：按收支发生日期汇总可见订单的资金明细。"""
    _validate_date_range(from_date, to_date)
    orders_stmt = _apply_order_scope(
        select(Order.id, Order.order_type), user, session
    )
    order_rows = session.execute(orders_stmt).all()
    cashflow_by_order = cashflow_totals_by_order(
        session,
        order_ids=[row[0] for row in order_rows],
        from_date=from_date,
        to_date=to_date,
    )

    revenue: dict[str, Decimal] = defaultdict(lambda: ZERO)
    cost: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for order_id, order_type in order_rows:
        if order_id not in cashflow_by_order:
            continue
        income, expense, _buy = cashflow_by_order[order_id]
        revenue[order_type] += income
        cost[order_type] += expense

    items = []
    for order_type in sorted(set(revenue) | set(cost)):
        income = revenue[order_type]
        direct = cost[order_type]
        gross_profit = income - direct
        classification = classification_for_order_type(order_type) or {
            "business_mode": None,
            "business_type": None,
            "value_added_service": None,
        }
        items.append(
            {
                "order_type": order_type,
                **classification,
                "main_income": income,
                "cost": direct,
                "main_profit": gross_profit,
            }
        )
    return {
        "items": items,
        "total": {
            "main_income": _sum_report_field(items, "main_income"),
            "cost": _sum_report_field(items, "cost"),
            "main_profit": _sum_report_field(items, "main_profit"),
        },
    }
