"""公司分润比例与可分配利润（BAS-06-03 口径计算）。

从 service.py 拆出（2026-11-18）：比例读取、分润口径、比例/金额换算
都是纯口径知识，不含写路径。
"""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.trade import Order

from ._shared import _scoped_order

DEFAULT_PROFIT_COMPANY_RATE = Decimal("40")
DEFAULT_LOSS_COMPANY_RATE = Decimal("50")


def validate_amount_directions(amounts: list[Decimal], profit: Decimal) -> None:
    """每笔金额均须与订单盈亏方向一致，禁止正负互抵掩盖超额分配。"""
    if any((profit > 0 and amount < 0) or (profit < 0 and amount > 0) or (profit == 0 and amount != 0) for amount in amounts):
        raise Validation("每笔分润金额方向必须与订单利润一致")


def company_rate_for_order(order: Order, order_profit: Decimal) -> Decimal:
    """公司分润比例：盈利/亏损使用默认配置（规则域已下线，原快照全为空转）。"""
    raw = DEFAULT_LOSS_COMPANY_RATE if order_profit < 0 else DEFAULT_PROFIT_COMPANY_RATE
    rate = to_money(raw or 0)
    if rate < 0 or rate > 100:
        raise Validation("公司分润比例必须在 0% 到 100% 之间", details={"company_rate": str(rate)})
    return rate


def order_profit_of(session: Session, order: Order) -> Decimal:
    """订单总利润（orders/amounts 同源）。"""
    from app.shared.order_amounts import order_amounts

    return to_money(order_amounts(session, order.id)["PROFIT"])


def allocatable_profit_for(order_profit: Decimal, company_rate: Decimal) -> Decimal:
    """扣除公司比例后的可分配利润。"""
    return (order_profit * (Decimal("100") - company_rate) / Decimal("100")).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )


def allocation_terms(session: Session, order_id: int, user: CurrentUser | None = None) -> dict[str, Decimal]:
    """返回订单总利润、公司比例与扣除公司后的可分配利润。"""
    order = _scoped_order(session, order_id, user)
    order_profit = order_profit_of(session, order)
    company_rate = company_rate_for_order(order, order_profit)
    return {
        "order_profit": order_profit,
        "company_rate": company_rate,
        "allocatable_profit": allocatable_profit_for(order_profit, company_rate),
    }


def convert_action_allocation(
    session: Session,
    order_id: int,
    *,
    direction: str,
    value: Decimal,
    user: CurrentUser | None = None,
) -> Decimal | None:
    """Convert a grouped action share using the server's canonical order profit.

    比例分母与落库/对账统一为**订单总利润**：四项（买号/售出/运营/公司）合计
    100%、公司占其中 40%/50%，故每一项的 rate 本就是相对总利润的百分比。
    换算若改用「可分配利润（扣公司后）」做基数，同一比例会算出偏小的金额
    （如利润 1000、公司 40%、BUY 20% → 换算 120 但对账 200），前端展示与
    实际应付对不上，故此处必须用 order_profit_of 的原值。
    """
    order = _scoped_order(session, order_id, user)
    order_profit = order_profit_of(session, order)
    input_value = to_money(value)
    if direction == "RATE_TO_AMOUNT":
        if input_value < 0 or input_value > 100:
            raise Validation("分润比例必须在 0% 到 100% 之间")
        return (order_profit * input_value / Decimal("100")).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )
    if direction == "AMOUNT_TO_RATE":
        if order_profit == 0:
            return None
        return (input_value * Decimal("100") / order_profit).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )
    raise Validation("不支持的分润换算方向")


__all__ = [
    "DEFAULT_LOSS_COMPANY_RATE",
    "DEFAULT_PROFIT_COMPANY_RATE",
    "allocatable_profit_for",
    "allocation_terms",
    "company_rate_for_order",
    "convert_action_allocation",
    "order_profit_of",
]
