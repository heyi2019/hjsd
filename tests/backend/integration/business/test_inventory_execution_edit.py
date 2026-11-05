"""INVENTORY-02 库存执行事件编辑后的库存与资金一致性。"""

from datetime import date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select

from app.stocks import service as accounts
from app.domain.foundation import AuditLog
from app.domain.trade import Account, Cashflow, Order, OrderEvent
from app.orders import service as orders


def test_inventory_edit_updates_event_flow_and_cost_without_changing_time(seeded_client, seeded_db, headers):
    account = accounts.create_account(seeded_db, game_account="edit-inventory", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = orders.create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    orders.post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    original_time = event.occurred_on
    response = seeded_client.patch(f"/api/v1/stocks/{account.id}/execution-edit", headers=headers, json={"events": [{"id": event.id, "expected_amount": "100.00", "amount": "150.00", "note": "修改"}]})
    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(Account, account.id).cost_amount == Decimal("150")
    edited = seeded_db.get(OrderEvent, event.id)
    assert edited.amount == Decimal("150") and edited.note == "修改" and edited.occurred_on == original_time
    flows = seeded_db.scalars(select(Cashflow).where(Cashflow.order_event_id == event.id)).all()
    assert len(flows) == 1 and flows[0].amount == Decimal("150") and flows[0].occurred_on == original_time
    assert seeded_db.scalar(select(AuditLog).where(AuditLog.entity_type == "inventory_event_edit", AuditLog.entity_id == str(event.id))) is not None


def test_inventory_edit_saves_profile_and_amount_together(seeded_client, seeded_db, headers):
    account = accounts.create_account(seeded_db, game_account="before-edit", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = orders.create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    orders.post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    response = seeded_client.patch(f"/api/v1/stocks/{account.id}/execution-edit", headers=headers, json={"profile": {"game_account": "after-edit"}, "events": [{"id": event.id, "expected_amount": "100", "amount": "150", "note": "ok"}]})
    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(Account, account.id).game_account == "after-edit"
    assert seeded_db.get(OrderEvent, event.id).amount == Decimal("150")


def test_stale_amount_rejects_whole_edit(seeded_client, seeded_db, headers):
    account = accounts.create_account(seeded_db, game_account="stale-before", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = orders.create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    orders.post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    response = seeded_client.patch(f"/api/v1/stocks/{account.id}/execution-edit", headers=headers, json={"profile": {"game_account": "must-not-save"}, "events": [{"id": event.id, "expected_amount": "99", "amount": "150"}]})
    assert response.status_code == 409
    seeded_db.expire_all()
    assert seeded_db.get(Account, account.id).game_account == "stale-before"
    assert seeded_db.get(OrderEvent, event.id).amount == Decimal("100")


def test_cannot_edit_event_of_another_account(seeded_client, seeded_db, headers):
    first = accounts.create_account(seeded_db, game_account="first", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    second = accounts.create_account(seeded_db, game_account="second", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = orders.create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=second.id)
    orders.post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    response = seeded_client.patch(f"/api/v1/stocks/{first.id}/execution-edit", headers=headers, json={"events": [{"id": event.id, "expected_amount": "100", "amount": "150"}]})
    assert response.status_code == 404
    seeded_db.expire_all()
    assert seeded_db.get(OrderEvent, event.id).amount == Decimal("100")


def test_edit_execution_operator_preserves_time_and_records_actual_editor(seeded_client, seeded_db, headers):
    account = accounts.create_account(seeded_db, game_account="operator-edit", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = orders.create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    orders.post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    timestamp = event.created_at
    response = seeded_client.patch(f"/api/v1/stocks/{account.id}/execution-edit", headers=headers, json={"events": [{"id": event.id, "expected_amount": "100", "amount": "100", "operator_user_ids": [1, 2]}]})
    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    updated = seeded_db.get(OrderEvent, event.id)
    assert updated.created_by == "pytest" and updated.operator_user_ids == [1, 2] and updated.created_at == timestamp
    audit = seeded_db.scalar(select(AuditLog).where(AuditLog.entity_type == "inventory_event_edit", AuditLog.entity_id == str(event.id)))
    assert audit.actor == "admin" and audit.before_json["operator_user_ids"] is None and audit.after_json["operator_user_ids"] == [1, 2]
    detail = seeded_client.get(f"/api/v1/stocks/{account.id}/execution-detail", headers=headers)
    assert detail.status_code == 200
    shown = detail.json()["orders"][0]["events"][0]
    assert shown["operator_user_ids"] == [1, 2]
    assert shown["operator_names"] == ["种子用户1", "种子用户2"]


def test_operator_selection_rejects_unknown_users(seeded_client, seeded_db, headers):
    account = accounts.create_account(seeded_db, game_account="unknown-operator", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = orders.create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    orders.post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    response = seeded_client.patch(f"/api/v1/stocks/{account.id}/execution-edit", headers=headers, json={"events": [{"id": event.id, "expected_amount": "100", "amount": "100", "operator_user_ids": [999999]}]})
    assert response.status_code == 422
    seeded_db.expire_all()
    assert seeded_db.get(OrderEvent, event.id).operator_user_ids is None


def test_zero_amount_execution_can_change_operators_without_cashflow(seeded_client, seeded_db, headers):
    account = accounts.create_account(seeded_db, game_account="zero-event", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = orders.create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    event = OrderEvent(order_id=order.id, event_no="ZERO-OP-001", event_type="DELIVER", amount=Decimal("0"), portion="GROSS", occurred_on=date(2026, 10, 1), is_posted=True, created_by="pytest", updated_by="pytest")
    seeded_db.add(event)
    seeded_db.commit()
    response = seeded_client.patch(f"/api/v1/stocks/{account.id}/execution-edit", headers=headers, json={"events": [{"id": event.id, "expected_amount": "0", "amount": "0", "operator_user_ids": [1, 2]}]})
    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(OrderEvent, event.id).operator_user_ids == [1, 2]


def test_operator_edit_does_not_change_existing_cashflow_amount(seeded_client, seeded_db, headers):
    account = accounts.create_account(seeded_db, game_account="operator-flow", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = orders.create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    orders.post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    event = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id))
    flow = seeded_db.scalar(select(Cashflow).where(Cashflow.order_event_id == event.id))
    flow.amount = Decimal("90")
    seeded_db.commit()
    response = seeded_client.patch(f"/api/v1/stocks/{account.id}/execution-edit", headers=headers, json={"events": [{"id": event.id, "expected_amount": "100", "amount": "100", "operator_user_ids": [1, 2]}]})
    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(Cashflow, flow.id).amount == Decimal("90")


def test_inventory_time_shift_moves_all_three_displayed_times_together(seeded_client, seeded_db, headers):
    """台账编辑态时间联动：任一锚点改 N 天，账期、事件、流水与三个展示时间同步平移。"""
    account = accounts.create_account(seeded_db, game_account="time-shift", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    other = accounts.create_account(seeded_db, game_account="time-shift-other", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = orders.create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    other_order = orders.create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=other.id)
    orders.post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    orders.post_event(seeded_db, order.id, event_type="SELL", amount=Decimal("200"), occurred_on=date(2026, 10, 3), actor="pytest")
    orders.post_event(seeded_db, other_order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    seeded_db.commit()

    url = f"/api/v1/stocks/{account.id}"
    before = seeded_client.get(f"{url}/execution-detail", headers=headers).json()["orders"][0]
    created_before = seeded_db.get(Order, order.id).created_at
    event_dates_before = {item["id"]: item["occurred_on"] for item in before["events"]}
    buy_before = next(item for item in before["events"] if item["event_type"] == "BUY")

    response = seeded_client.patch(f"{url}/execution-edit", headers=headers, json={"events": [], "time_shift": {"delta_minutes": 7200}})
    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    shifted = seeded_db.get(Order, order.id)
    assert shifted.trade_date == date(2026, 10, 6)
    assert shifted.created_at == created_before + timedelta(days=5)
    assert seeded_db.get(Order, other_order.id).trade_date == date(2026, 10, 1)  # 不波及其它账号

    after = seeded_client.get(f"{url}/execution-detail", headers=headers).json()["orders"][0]
    assert after["created_at"][:10] == (created_before + timedelta(days=5)).date().isoformat()
    assert after["trade_date"] == "2026-10-06"
    for item in after["events"]:
        assert (date.fromisoformat(item["occurred_on"]) - date.fromisoformat(event_dates_before[item["id"]])).days == 5
    buy_after = next(item for item in after["events"] if item["event_type"] == "BUY")
    # 台账「售出时间」取 event.occurred_at(posted_at/created_at)，「流水时间」取 cashflow.occurred_at(created_at)
    assert buy_after["occurred_at"][:10] == (date.fromisoformat(buy_before["occurred_at"][:10]) + timedelta(days=5)).isoformat()
    assert buy_after["cashflow"]["occurred_at"][:10] == (date.fromisoformat(buy_before["cashflow"]["occurred_at"][:10]) + timedelta(days=5)).isoformat()
    assert buy_after["cashflow"]["occurred_on"] == "2026-10-06"
    assert seeded_db.scalar(select(AuditLog).where(AuditLog.entity_type == "inventory_time_shift", AuditLog.entity_id == str(account.id))) is not None

    # 零平移是 no-op，不会重复改动时间轴
    idle = seeded_client.patch(f"{url}/execution-edit", headers=headers, json={"events": [], "time_shift": {"delta_minutes": 0}})
    assert idle.status_code == 200, idle.text
    seeded_db.expire_all()
    assert seeded_db.get(Order, order.id).trade_date == date(2026, 10, 6)


def test_inventory_time_set_absolutely_sets_and_clears_three_timestamps(seeded_client, seeded_db, headers):
    """#15 需求2：台账三个系统时间戳可绝对设值，也可清空（置 NULL）。

    登记时间 → Order.created_at；售出时间 → 来源单 SELL 事件 posted_at；
    流水时间 → 来源单首条资金流水 Cashflow.created_at。两者均为可空列（DDL 已放开）。
    """
    account = accounts.create_account(seeded_db, game_account="time-set", business_mode="SELF", inventory_type="RECOVERY", actor="pytest")
    order = orders.create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest", account_id=account.id)
    orders.post_event(seeded_db, order.id, event_type="BUY", amount=Decimal("100"), occurred_on=date(2026, 10, 1), actor="pytest")
    orders.post_event(seeded_db, order.id, event_type="SELL", amount=Decimal("200"), occurred_on=date(2026, 10, 3), actor="pytest")
    seeded_db.commit()

    url = f"/api/v1/stocks/{account.id}/execution-edit"

    # 绝对设值：三个时间戳各自独立写入。
    set_resp = seeded_client.patch(url, headers=headers, json={"events": [], "time_set": {
        "registered_at": "2026-01-15T08:30:00",
        "sold_at": "2026-02-20T09:15:00",
        "flow_at": "2026-03-25T10:45:00",
    }})
    assert set_resp.status_code == 200, set_resp.text
    seeded_db.expire_all()
    assert seeded_db.get(Order, order.id).created_at == datetime(2026, 1, 15, 8, 30, 0)
    sell = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "SELL", OrderEvent.is_posted.is_(True)))
    assert sell is not None and sell.posted_at == datetime(2026, 2, 20, 9, 15, 0)
    flow = seeded_db.scalar(select(Cashflow).where(Cashflow.order_id == order.id).order_by(Cashflow.occurred_on, Cashflow.id))
    assert flow is not None and flow.created_at == datetime(2026, 3, 25, 10, 45, 0)
    assert seeded_db.scalar(select(AuditLog).where(AuditLog.entity_type == "inventory_time_set", AuditLog.entity_id == str(account.id))) is not None

    # 清空（置 NULL）：三个时间戳均可删除。
    clear_resp = seeded_client.patch(url, headers=headers, json={"events": [], "time_set": {
        "registered_at": None, "sold_at": None, "flow_at": None,
    }})
    assert clear_resp.status_code == 200, clear_resp.text
    seeded_db.expire_all()
    assert seeded_db.get(Order, order.id).created_at is None
    sell2 = seeded_db.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_type == "SELL", OrderEvent.is_posted.is_(True)))
    assert sell2 is not None and sell2.posted_at is None
    flow2 = seeded_db.scalar(select(Cashflow).where(Cashflow.order_id == order.id).order_by(Cashflow.occurred_on, Cashflow.id))
    assert flow2 is not None and flow2.created_at is None
