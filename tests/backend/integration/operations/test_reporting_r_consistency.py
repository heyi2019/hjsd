"""REPORT-01：核对同日一致与跨期各自的日期口径。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.business import events
from app.business.create import create_order
from app.operations.profit import order_profit_detail
from app.operations.r5_business_pnl import r5_business_pnl
from app.funds.cashflows import create_cashflow

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
    assert detail["total"]["cost"] == Decimal("100.00")
    assert detail["total"]["net_profit"] == Decimal("200.00")

    # 交叉一致：R5 的 main_* 必须与订单利润明细的合计逐项相等
    assert r5["total"]["main_income"] == detail["total"]["income"]
    assert r5["total"]["cost"] == detail["total"]["cost"]
    assert r5["total"]["main_profit"] == detail["total"]["net_profit"]
    # 历史无流水区间不应显示现存订单的业务类型。
    assert r5_business_pnl(seeded_db, from_date=date(2000, 1, 1), to_date=date(2000, 1, 31))["items"] == []
    create_cashflow(
        seeded_db, pool_id=1, occurred_on=date(2026, 10, 18), direction="OUT",
        category="OTHER", amount=Decimal("10"), actor="pytest", order_id=order.id,
    )
    # 订单利润按订单日期包含整单收支；业务损益只计所选期间的收支。
    detail = order_profit_detail(seeded_db, from_date=TODAY, to_date=TODAY)
    r5 = r5_business_pnl(seeded_db, from_date=TODAY, to_date=TODAY)
    assert detail["total"]["net_profit"] == Decimal("190.00")
    assert r5["total"]["main_profit"] == Decimal("200.00")
    next_day = r5_business_pnl(seeded_db, from_date=date(2026, 10, 18), to_date=date(2026, 10, 18))
    assert next_day["total"]["main_profit"] == Decimal("-10.00")
