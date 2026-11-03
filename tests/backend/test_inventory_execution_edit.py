"""INVENTORY-02 库存执行事件编辑后的库存与资金一致性。"""

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.stocks import service as accounts
from app.domain.foundation import AuditLog
from app.domain.trade import Account, Cashflow, OrderEvent
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
