"""EVENT-01 订单事件服务拆分后的直接契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.domain.trade import Cashflow
from app.orders.consignment import register_consignment
from app.orders import events
from app.orders.create import create_order
from app.orders.events import _opposite_direction, post_event


TODAY = date(2026, 10, 17)


def test_events_module_posts_event_without_using_facade(seeded_db):
    order = create_order(
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
    assert post_event is events.post_event
    assert _opposite_direction is events._opposite_direction


def test_operate_event_records_business_action_without_cashflow(seeded_db):
    order = create_order(
        seeded_db,
        order_type="TH",
        trade_date=TODAY,
        actor="pytest",
    )

    event, flow = register_consignment(
        seeded_db,
        order.id,
        occurred_on=TODAY,
        actor="pytest",
        note="寄售上架",
    )

    assert event.event_type == "OPERATE"
    assert (event.form_extra or {}).get("operation_type") == "CONSIGNMENT"
    assert flow is None
    assert seeded_db.scalar(
        select(Cashflow.id).where(Cashflow.order_event_id == event.id)
    ) is None
