"""IDEMPOTENCY-01：记录 post_event 当前的重复提交行为。

已知风险：orders.events.post_event **没有全局幂等键**——同一笔业务事件
（如同一笔收款被支付网关 / webhook 重复推送、前端重复提交）被重复调用时，
会生成重复的 OrderEvent 与 Cashflow，导致资金重复记账。

本文件保留现状基线，待增加幂等键或业务事件去重后改为正确性断言。

测试断言的是「当前（有缺陷的）行为」，不是「正确行为」；修复后此测试应改为
断言只产生 1 笔流水。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.finance.cashflows import list_cashflows
from app.orders import events
from app.orders import service as orders_service

TODAY = date(2026, 10, 17)


def test_duplicate_buy_posts_duplicate_cashflows(seeded_db):
    """重复登记同一 BUY 当前会生成两笔流水。"""
    order = orders_service.create_order(
        seeded_db, order_type="TH", trade_date=TODAY, actor="pytest",
    )
    events.post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=TODAY, actor="pytest",
    )
    # 重复调用（模拟 webhook 重试 / 重复提交）
    events.post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=TODAY, actor="pytest",
    )
    _rows, total = list_cashflows(seeded_db, order_id=order.id)
    # 增加幂等键后，此断言应改为 == 1。
    assert total == 2
