"""NOTIFY-01 分润提醒开关控制新通知，不改动订单和已有消息。"""
from datetime import date

import pytest

from app.core.errors import Validation

from sqlalchemy import select

from app.business.create import create_order
from app.business.events import post_event
from app.domain.notifications import Notification
from app.domain.options import OptionSet
from app.domain.users import User
from app.funds.profit_allocation.service import set_allocations
from app.workbench.notifications.service import PROFIT_ALLOCATED, PROFIT_PENDING
from app.workbench.reminder_config import REMINDER_CODE


def test_profit_notification_setting_controls_new_messages_only(seeded_db):
    seller_id = seeded_db.scalar(select(User.id).where(User.username == "seeduser1"))
    recipient_id = seeded_db.scalar(select(User.id).where(User.username == "seeduser2"))
    assert seller_id is not None and recipient_id is not None
    settings = seeded_db.scalar(select(OptionSet).where(OptionSet.code == REMINDER_CODE))
    if settings is None:
        settings = OptionSet(code=REMINDER_CODE, label="业务提醒", group="BUSINESS", editable=False, options=[])
        seeded_db.add(settings)
        seeded_db.flush()

    def configure(value: str):
        settings.options = [{"value": "inventory_aging_days", "label": "7"},
                            {"value": "profit_notifications_enabled", "label": value},
                            {"value": "overdue_installments_enabled", "label": "1"}]
        seeded_db.flush()

    def sell_and_allocate(suffix: str):
        order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 4),
                             actor="pytest", account_snapshot={"game_account": f"profit-switch-{suffix}"})
        post_event(seeded_db, order.id, event_type="BUY", amount="500", occurred_on=date(2026, 10, 4), actor="pytest")
        post_event(seeded_db, order.id, event_type="SELL", amount="800", occurred_on=date(2026, 10, 18),
                   actor="seeduser1", operator_user_ids=[seller_id])
        set_allocations(seeded_db, order.id, items=[{"user_id": recipient_id, "role": "OWNER", "allocation_rate": "100"}], actor="pytest")
        return order

    def messages(order):
        return list(seeded_db.scalars(select(Notification).where(Notification.entity_type == "order", Notification.entity_id == order.order_no)).all())

    configure("1")
    before = sell_and_allocate("before")
    original = messages(before)
    assert {item.notification_type for item in original} == {PROFIT_PENDING, PROFIT_ALLOCATED}

    configure("0")
    disabled = sell_and_allocate("disabled")
    assert messages(disabled) == []
    assert {item.id for item in messages(before)} == {item.id for item in original}
    assert all(item.read_at is None for item in messages(before))

    configure("1")
    after = sell_and_allocate("after")
    assert {item.notification_type for item in messages(after)} == {PROFIT_PENDING, PROFIT_ALLOCATED}
    assert messages(disabled) == []

    configure("false")
    with pytest.raises(Validation, match="业务提醒开关配置无效"):
        sell_and_allocate("invalid")
