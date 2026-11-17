"""parties.counterparty_detail：合作方详情中的经营汇总与成单明细。"""
from __future__ import annotations

from collections import OrderedDict
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.enums import OrderStatus
from app.domain.parties import OrderCounterpartyRole
from app.domain.trade import Order
from app.shared.order_amounts import order_cashflow_profit_by_order

from .counterparties import get_counterparty


def get_counterparty_detail(session: Session, counterparty_id: int) -> dict[str, Any]:
    """按合作方历史参与关系汇总订单数、利润和成单明细。"""
    counterparty = get_counterparty(session, counterparty_id)
    rows = session.execute(
        select(OrderCounterpartyRole, Order)
        .join(Order, Order.id == OrderCounterpartyRole.order_id)
        .where(OrderCounterpartyRole.counterparty_id == counterparty.id)
        .order_by(Order.trade_date.desc(), Order.id.desc())
    ).all()

    orders_by_id: OrderedDict[int, dict[str, Any]] = OrderedDict()
    for role_row, order in rows:
        item = orders_by_id.setdefault(
            order.id,
            {
                "order_id": order.id,
                "order_no": order.order_no,
                "order_type": order.order_type,
                "status": order.status,
                "trade_date": order.trade_date,
                "roles": [],
            },
        )
        if role_row.role not in item["roles"]:
            item["roles"].append(role_row.role)

    orders = list(orders_by_id.values())
    profits = order_cashflow_profit_by_order(session, order_ids=list(orders_by_id))
    for item in orders:
        item["profit"] = profits.get(item["order_id"], 0)

    return {
        "overview": {
            "order_count": len(orders),
            "active_order_count": sum(
                item["status"] in {OrderStatus.ACTIVE.value, OrderStatus.INSTALLMENT.value}
                for item in orders
            ),
            "completed_order_count": sum(
                item["status"] == OrderStatus.COMPLETED.value for item in orders
            ),
            "cumulative_profit": sum((item["profit"] for item in orders), 0),
        },
        "orders": orders,
    }
