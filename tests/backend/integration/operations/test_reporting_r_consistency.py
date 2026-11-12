"""REPORT-01 报表一致性契约测试（阶段5 高风险）：R5 业务损益 与 订单利润明细 对账。

两个报表都从同一组过账事件派生利润（income / buy_amount / direct_cost），
结果必须交叉一致：对同一数据集，R5 的合计应与订单利润明细的合计逐项相等。
这是「改一个报表、另一个报表口径漂移」类回归的护栏。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.orders import events
from app.orders.create import create_order
from app.reporting.profit import order_profit_detail
from app.reporting.r5_business_pnl import r5_business_pnl

TODAY = date(2026, 10, 17)


def test_r5_and_order_profit_detail_agree_on_profit(seeded_db):
    # TH 售出单：先 BUY（成本）再 SELL（收入），无返点 / 坏账，口径干净。
    order = create_order(
        seeded_db, order_type="TH", trade_date=TODAY, actor="pytest",
    )
    events.post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=TODAY, actor="pytest",
    )
    events.post_event(
        seeded_db, order.id, event_type="SELL", amount=Decimal("300"),
        occurred_on=TODAY, actor="pytest",
    )

    detail = order_profit_detail(seeded_db, from_date=TODAY, to_date=TODAY)
    r5 = r5_business_pnl(seeded_db, from_date=TODAY, to_date=TODAY)

    # 订单利润明细自身口径
    assert detail["total"]["income"] == Decimal("300.00")
    assert detail["total"]["buy_amount"] == Decimal("100.00")
    assert detail["total"]["net_profit"] == Decimal("200.00")

    # 交叉一致：R5 的 main_* 必须与订单利润明细的合计逐项相等
    assert r5["total"]["main_income"] == detail["total"]["income"]
    assert r5["total"]["main_cost"] == (
        detail["total"]["buy_amount"] + detail["total"]["direct_cost"]
    )
    assert r5["total"]["main_profit"] == detail["total"]["net_profit"]
