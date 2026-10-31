"""reporting.profit：订单利润明细（RPT-01）。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any
from app.core.security import CurrentUser
from app.parties import service as parties_service
from sqlalchemy import (
    func,
    select,
)
from sqlalchemy.orm import Session
from app.domain.trade import (
    Order,
    OrderEvent,
    RebateRecord,
    RebateSettlement,
)

from ._shared import (
    ZERO,
    _apply_order_scope,
    _bad_debt_by_order,
    _event_gain_cases,
    _event_offset_join,
    _money,
    _sum_report_field,
    _validate_date_range,
)

def order_profit_detail(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """订单利润明细：合计与 R5 对应维度一致，可导出但不改原始数据。

    2026-10-28 性能改造：订单取列级元组、事件损益在 SQL 端按订单条件求和
    （CANCEL 冲销经同单自连接解析），不再全量 ORM 水合事件。返回口径一致。
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
    orders = session.execute(orders_stmt).all()
    order_ids = [row.id for row in orders]
    extra_values = parties_service.get_extra_values_bulk(
        session, entity_type="order", entity_ids=order_ids
    )
    # 事件损益一次分组聚合替代「全量事件水合 + 逐单 Python 汇总」。
    # 注意每个订单只聚合本单事件：CANCEL 的 offset 归属判定依赖同单事件，
    # 自连接带同单约束，跨单混入不会改口径（与旧实现注释口径一致）。
    totals_by_order: dict[int, tuple[Decimal, Decimal, Decimal]] = {}
    if order_ids:
        offset, (income_case, buy_case, cost_case) = _event_gain_cases(OrderEvent.amount)
        event_agg = (
            select(
                OrderEvent.order_id.label("order_id"),
                func.coalesce(func.sum(income_case), 0).label("income"),
                func.coalesce(func.sum(buy_case), 0).label("buy_amount"),
                func.coalesce(func.sum(cost_case), 0).label("direct_cost"),
            )
            .outerjoin(offset, _event_offset_join(offset))
            .where(OrderEvent.is_posted.is_(True))
            .group_by(OrderEvent.order_id)
        )
        for order_id, income, buy_amount, direct_cost in session.execute(event_agg).all():
            totals_by_order[order_id] = (
                _money(income),
                _money(buy_amount),
                _money(direct_cost),
            )
    settlements_by_order: dict[int, list[tuple[Any, Any, Any]]] = defaultdict(list)
    if order_ids:
        settlement_rows = session.execute(
            select(
                RebateRecord.source_order_id,
                RebateSettlement.gross_amount,
                RebateSettlement.platform_fee,
                RebateSettlement.reversal_of_id,
            )
            .join(
                RebateSettlement, RebateSettlement.rebate_record_id == RebateRecord.id
            )
            .where(RebateRecord.source_order_id.in_(order_ids))
        )
        for source_order_id, gross, fee, reversal_of_id in settlement_rows:
            settlements_by_order[source_order_id].append((gross, fee, reversal_of_id))
    bad_debt_by_order = _bad_debt_by_order(session, user=user)
    no_totals = (_money(0), _money(0), _money(0))
    items = []
    for order in orders:
        if from_date and order.trade_date < from_date:
            continue
        if to_date and order.trade_date > to_date:
            continue
        income, buy, direct_cost = totals_by_order.get(order.id, no_totals)
        direct_cost += bad_debt_by_order.get(order.id, ZERO)
        rebate = ZERO
        for gross, fee, reversal_of_id in settlements_by_order.get(order.id, []):
            sign = Decimal("-1") if reversal_of_id is not None else Decimal("1")
            rebate += sign * _money(gross)
            direct_cost += sign * _money(fee)
        items.append(
            {
                "order_no": order.order_no,
                "order_id": order.id,
                "order_type": order.order_type,
                "trade_date": order.trade_date.isoformat(),
                "status": order.status,
                "income": income,
                "buy_amount": buy,
                "direct_cost": direct_cost,
                "rebate": rebate,
                "net_profit": income - buy - direct_cost + rebate,
                "extra_values": extra_values.get(order.id, {}),
            }
        )
    return {
        "items": items,
        "total": {
            "income": _sum_report_field(items, "income"),
            "buy_amount": _sum_report_field(items, "buy_amount"),
            "direct_cost": _sum_report_field(items, "direct_cost"),
            "rebate": _sum_report_field(items, "rebate"),
            "net_profit": _sum_report_field(items, "net_profit"),
        },
    }
