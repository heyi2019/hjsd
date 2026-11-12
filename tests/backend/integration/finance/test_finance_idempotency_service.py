"""IDEMPOTENCY-01 post_event 幂等性风险登记（阶段5 高风险 / 已知缺陷）。

已知风险：orders.events.post_event **没有全局幂等键**——同一笔业务事件
（如同一笔收款被支付网关 / webhook 重复推送、前端重复提交）被重复调用时，
会生成重复的 OrderEvent 与 Cashflow，导致资金重复记账。

本文件用测试把这一行为「钉住」，作为后续修复的回归基线，并明确标注为
待裁决项。**按「先报后改」原则，本次测试任务不在此直接改 post_event 代码**，
仅记录现状与风险，待用户裁决修复方案（加幂等键 / 业务事件去重）。

测试断言的是「当前（有缺陷的）行为」，不是「正确行为」；修复后此测试应改为
断言只产生 1 笔流水。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.finance.cashflows import list_cashflows
from app.orders import events
from app.orders.create import create_order

TODAY = date(2026, 10, 17)


def test_duplicate_buy_posts_duplicate_cashflows(seeded_db):
    """RISK / 已知缺陷：重复登记同一 BUY 不会去重，生成两笔流水。

    业务含义：网关/webhook 重试、前端重复提交都会触发重复记账。
    当前实现无幂等键，这是资金域最高优先级待修复项之一。
    """
    order = create_order(
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
    # 现状：无幂等 → 2 笔流水。修复（加幂等键）后此断言应改为 == 1。
    assert total == 2
