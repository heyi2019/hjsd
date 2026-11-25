"""reporting.profit：订单利润明细（RPT-01）。

利润口径（2026-11-05 用户裁决）：**该订单所有收入 − 所有支出**，
可正可负可 0；与分润基数同源，取数统一走 `cashflow_totals_by_order`。
资金走向只有收入 / 支出两种，不以「是否生成资金流水」为界：
收入 = 资金流水 IN + 返点记录金额；支出 = 资金流水 OUT + 分期坏账金额。
收入大类 = 售出价 + 返点 + 其他收入子类型；支出大类 = 所有支出子类型。
返点列是「其中返点收入」展示项、已含在收入大类，不重复计入净利。
作废（VOID）返点不是收入，随收入大类一起排除，与售出价 CANCEL 冲销同规则。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any
from app.core.security import CurrentUser
from app.shared.form_values import get_extra_values_bulk
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from app.domain.trade import (
    Order,
    RebateRecord,
)

from app.core.money import to_money_or_zero
from .._shared import (
    ZERO,
    _apply_order_scope,
    _validate_date_range,
    cashflow_totals_by_order,
)

def order_profit_detail(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None, limit: int | None = None, offset: int = 0,
    sort_desc: bool = True,
) -> dict[str, Any]:
    """订单利润明细：按订单日期筛选，金额包含该订单所有日期的收支。

    经营损益按收支发生日期统计，跨期数据不必相等。订单范围先按权限过滤，
    再一次性按订单汇总资金流水，避免逐单查询。
    """
    _validate_date_range(from_date, to_date)
    orders_stmt = _apply_order_scope(
        select(
            Order.id.label("id"),
            Order.order_no.label("order_no"),
            Order.order_type.label("order_type"),
            Order.trade_date.label("trade_date"),
            Order.status.label("status"),
        ),
        user,
        session,
    )
    if from_date is not None:
        orders_stmt = orders_stmt.where(Order.trade_date >= from_date)
    if to_date is not None:
        orders_stmt = orders_stmt.where(Order.trade_date <= to_date)
    if limit is None:
        orders = session.execute(orders_stmt).all()
        order_ids = [row.id for row in orders]
    else:
        order_columns = (Order.trade_date.desc(), Order.id.desc()) if sort_desc else (Order.trade_date.asc(), Order.id.asc())
        order_ids = list(session.scalars(orders_stmt.with_only_columns(Order.id).order_by(*order_columns)))
        page_ids = order_ids[offset:offset + limit]
        orders = session.execute(orders_stmt.where(Order.id.in_(page_ids)).order_by(*order_columns)).all() if page_ids else []
    extra_values = get_extra_values_bulk(
        session, entity_type="order", entity_ids=[row.id for row in orders]
    )
    cashflow_by_order = cashflow_totals_by_order(session, order_ids=order_ids)
    # 返点收益列 = 该订单返点记录金额合计，与收入列里的返点部分是同一笔钱。
    rebate_by_order: dict[int, Decimal] = defaultdict(lambda: ZERO)
    if order_ids:
        rebate_rows = session.execute(
            select(
                RebateRecord.source_order_id,
                func.coalesce(func.sum(RebateRecord.amount), 0),
            )
            .where(RebateRecord.source_order_id.in_(order_ids))
            .group_by(RebateRecord.source_order_id)
        )
        for source_order_id, amount in rebate_rows:
            rebate_by_order[int(source_order_id)] = to_money_or_zero(amount)
    no_totals = (ZERO, ZERO, ZERO)
    items = []
    for order in orders:
        income, expense, _account_cost = cashflow_by_order.get(order.id, no_totals)
        rebate = rebate_by_order.get(order.id, ZERO)
        items.append(
            {
                "order_no": order.order_no,
                "order_id": order.id,
                "order_type": order.order_type,
                "trade_date": order.trade_date.isoformat(),
                "status": order.status,
                "income": income,
                "cost": expense,
                # 返点收入已计入上面的 income，此处只作其中项展示，不重复加进净利。
                "rebate": rebate,
                "net_profit": income - expense,
                "extra_values": extra_values.get(order.id, {}),
            }
        )
    income_total = sum((cashflow_by_order.get(order_id, no_totals)[0] for order_id in order_ids), ZERO)
    cost_total = sum((cashflow_by_order.get(order_id, no_totals)[1] for order_id in order_ids), ZERO)
    return {
        "items": items,
        "count": len(order_ids),
        "total": {
            "income": income_total,
            "cost": cost_total,
            "rebate": sum((rebate_by_order.get(order_id, ZERO) for order_id in order_ids), ZERO),
            "net_profit": income_total - cost_total,
        },
    }
