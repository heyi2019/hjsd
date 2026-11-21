"""EVENT-01 订单事件服务拆分后的直接契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import select

from app.domain.trade import Cashflow
from app.business.consignment import register_consignment
from app.business import events
from app.business.create import create_order
from app.business.events import _opposite_direction, post_event
from app.business.listing_state import active_listings


TODAY = date(2026, 10, 17)


def test_active_listings_filters_many_unlistings_with_linear_matching():
    class CountedId(int):
        reads = 0

        def __str__(self):
            type(self).reads += 1
            return super().__str__()

    listed = [SimpleNamespace(id=CountedId(index), form_extra={
        "operation_type": "CONSIGNMENT", "consignment_platforms": ["甲", "乙"],
    }) for index in range(200)]
    unlisted = [SimpleNamespace(form_extra={
        "operation_type": "UNLIST", "consignment_event_id": index, "consignment_platforms": ["甲"],
    }) for index in range(200)]

    class EventsResult:
        def all(self):
            return listed + unlisted

    class EventsSession:
        def scalars(self, _statement):
            return EventsResult()

    result = active_listings(EventsSession(), 1)
    assert result == {(index, "乙") for index in range(200)}
    assert CountedId.reads <= 800


def test_active_listings_preserves_system_and_raw_platform_matching():
    events = [
        SimpleNamespace(id=1, form_extra={"operation_type": "CONSIGNMENT", "consignment_platforms": ["甲", "乙"]}),
        SimpleNamespace(id=2, form_extra={"operation_type": "CONSIGNMENT", "consignment_platforms": ["甲", "乙"]}),
        SimpleNamespace(form_extra={"operation_type": "UNLIST", "consignment_event_id": "1", "platform_unlist_scope": "SYSTEM"}),
        SimpleNamespace(form_extra={"operation_type": "UNLIST", "consignment_event_id": 2, "consignment_platforms": [" 甲 ", {"invalid": True}]}),
    ]
    session = SimpleNamespace(scalars=lambda _statement: SimpleNamespace(all=lambda: events))
    assert active_listings(session, 1) == {(2, "甲"), (2, "乙")}


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
    assert flow.source_type == "ORDER_EVENT"
    assert flow.source_id == event.event_no


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
        select(Cashflow.id).where(
            Cashflow.source_type == "ORDER_EVENT", Cashflow.source_id == event.event_no
        )
    ) is None
