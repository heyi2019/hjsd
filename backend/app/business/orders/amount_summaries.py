"""批量计算订单售出、成本与利润摘要，供台账和工作台共用。"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.money import to_money, to_money_or_zero
from app.domain.enums import AccountingAttribute, CashflowSourceType, Direction
from app.domain.trade import Cashflow, Order, OrderEvent
from app.shared.order_amounts import ZERO, event_totals, order_cashflow_profit_by_order


def sale_amount(order_type: str, events: list[OrderEvent]) -> Decimal | None:
    """列表展示的售出金额：只取 SELL，不把 BUY 成本合进来。"""
    sell_events = [event for event in events if event.event_type == "SELL"]
    if not sell_events:
        return None
    # 回收/提号可取消售出后重新售出；补录日期可能早于前次，按事件编号识别本次。
    # 历史资金流水仍单独参与利润计算。
    if order_type in ("HS", "TH"):
        return to_money(max(sell_events, key=lambda event: event.id).amount)
    if order_type == "DG":
        recorded = [
            to_money_or_zero((event.form_extra or {}).get("sale_amount"))
            for event in sell_events
            if (event.form_extra or {}).get("sale_amount") not in (None, "")
        ]
        if recorded:
            return sum(recorded, ZERO)
    return sum((to_money(event.amount) for event in sell_events), ZERO)



@dataclass(frozen=True)
class OrderAmountSummary:
    sale_amount: Decimal | None
    cost_amount: Decimal
    profit_base: Decimal


def order_amount_summaries(db: Session, orders: list[Order]) -> tuple[dict[int, OrderAmountSummary], dict[int, list[OrderEvent]]]:
    """按订单批量汇总，返回金额和已记账事件，避免逐单查询。"""
    ids = [order.id for order in orders]
    if not ids:
        return {}, {}
    profits = order_cashflow_profit_by_order(db, order_ids=ids)
    events_by_order: dict[int, list[OrderEvent]] = {}
    for event in db.scalars(
        select(OrderEvent)
        .where(OrderEvent.order_id.in_(ids), OrderEvent.is_posted.is_(True))
        .order_by(OrderEvent.occurred_on.desc(), OrderEvent.id.desc())
    ).all():
        events_by_order.setdefault(event.order_id, []).append(event)
    unlinked_costs = {
        order_id: to_money(total or 0)
        for order_id, total in db.execute(
            select(Cashflow.order_id, func.coalesce(func.sum(Cashflow.amount), 0))
            .where(
                Cashflow.order_id.in_(ids),
                Cashflow.source_type != CashflowSourceType.ORDER_EVENT.value,
                Cashflow.direction == Direction.OUT.value,
                Cashflow.accounting_attribute.in_((AccountingAttribute.SELF_DIRECT_COST.value, AccountingAttribute.TH_DIRECT_COST.value)),
            )
            .group_by(Cashflow.order_id)
        ).all()
    }
    result = {}
    for order in orders:
        events = events_by_order.get(order.id, [])
        _, event_cost, additional_cost = event_totals(events)
        result[order.id] = OrderAmountSummary(
            sale_amount=sale_amount(order.order_type, events),
            cost_amount=event_cost + additional_cost + unlinked_costs.get(order.id, ZERO),
            profit_base=profits.get(order.id, ZERO),
        )
    return result, events_by_order
