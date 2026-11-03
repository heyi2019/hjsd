"""EVENT-01 订单事件服务拆分后的直接契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.orders import events
from app.orders import service as orders_service


TODAY = date(2026, 10, 17)


def test_events_module_posts_event_without_using_facade(seeded_db):
    order = orders_service.create_order(
        seeded_db,
        order_type="TH",
        trade_date=TODAY,
        actor="pytest",
    )

    event, flow = events.post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal("100"),
        occurred_on=TODAY,
        actor="pytest",
    )

    assert event.order_id == order.id
    assert event.event_type == "BUY"
    assert flow is not None
    assert flow.order_event_id == event.id


def test_order_facade_re_exports_event_service():
    assert orders_service.post_event is events.post_event
    assert orders_service._opposite_direction is events._opposite_direction
