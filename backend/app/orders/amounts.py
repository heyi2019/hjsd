"""订单金额口径：已过账事件的收入 / 买入成本 / 直接费用汇总。

为什么单独成模块：
- 报表（app/reporting/service.py）与规则派生（返点基数、分期服务费基数）必须
  用同一套口径，否则「报表说成交额 1000，返点按 900 计提」这类不一致会查不出来。
- 该口径是订单域事实，不属于报表，下沉到 orders 域避免反向依赖。

口径（与 BAS 报表一致，勿凭直觉改）：
- SELL 事件金额 = 收入；BUY 事件金额 = 买入成本；COST 事件金额 = 直接费用；
- CANCEL 仅在其显式 offset 某事件时才做会计冲销；裸取消只改流程状态，不改历史损益。
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.domain.enums import EventType
from app.domain.trade import OrderEvent

ZERO = Decimal("0.00")


def _money(value: object) -> Decimal:
    return to_money(value or 0)


def event_contribution(
    event: OrderEvent, event_types: dict[int, str]
) -> tuple[Decimal, Decimal, Decimal]:
    """返回单个事件的 (income, buy_amount, direct_cost)。

    注意：本函数不判断 is_posted，由调用方过滤（与既有行为保持一致）。
    """
    amount = _money(event.amount)
    if event.event_type == EventType.SELL.value:
        return amount, ZERO, ZERO
    if event.event_type == EventType.BUY.value:
        return ZERO, amount, ZERO
    if event.event_type == EventType.COST.value:
        return ZERO, ZERO, amount
    if event.event_type == EventType.CANCEL.value and event.offset_event_id is not None:
        offset_type = event_types.get(event.offset_event_id)
        if offset_type == EventType.SELL.value:
            return -amount, ZERO, ZERO
        if offset_type == EventType.BUY.value:
            return ZERO, -amount, ZERO
        if offset_type == EventType.COST.value:
            return ZERO, ZERO, -amount
    return ZERO, ZERO, ZERO


def event_totals(
    events: list[OrderEvent], *, from_date: date | None = None, to_date: date | None = None
) -> tuple[Decimal, Decimal, Decimal]:
    """汇总一批事件的 (income, buy_amount, direct_cost)；跳过未过账与越界日期。"""
    event_types = {event.id: event.event_type for event in events}
    income = ZERO
    buy_amount = ZERO
    direct_cost = ZERO
    for event in events:
        if not event.is_posted:
            continue
        if from_date and event.occurred_on < from_date:
            continue
        if to_date and event.occurred_on > to_date:
            continue
        event_income, event_buy, event_cost = event_contribution(event, event_types)
        income += event_income
        buy_amount += event_buy
        direct_cost += event_cost
    return income, buy_amount, direct_cost


def order_amounts(session: Session, order_id: int) -> dict[str, Decimal]:
    """按订单取口径金额：成交额 / 本金 / 利润。

    - GROSS：卖出收入合计（成交额）
    - PRINCIPAL：买入成本合计（本金占用）
    - PROFIT：收入 - 买入成本 - 直接费用（不含返点，避免规则自引用）
    """
    events = list(
        session.scalars(select(OrderEvent).where(OrderEvent.order_id == order_id)).all()
    )
    income, buy_amount, direct_cost = event_totals(events)
    return {
        "GROSS": income,
        "PRINCIPAL": buy_amount,
        "PROFIT": income - buy_amount - direct_cost,
    }
