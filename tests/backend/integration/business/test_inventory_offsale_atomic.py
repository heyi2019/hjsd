from datetime import date

import pytest
from sqlalchemy import select

from app.business import schemas
from app.business.consignment import platform_unlist_consignment, register_consignment
from app.business.create import create_order
from app.business.events import post_event
from app.business.routers.order_events_router import inventory_offsale
from app.core.errors import Validation
from app.core.database import get_db
from app.core.security import DEV_USERS
from app.domain.trade import Account, Order, OrderEvent


def test_failed_system_offsale_rolls_back_platform_events(seeded_db):
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "atomic-offsale", "game_type": "王者荣耀"})
    register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
        form_extra={"consignment_platforms": ["测试平台"]})
    seeded_db.commit()
    order_id, account_id = order.id, order.account_id
    payload = schemas.InventoryOffsaleIn(reason=" ", occurred_on=date(2026, 11, 2), unlisted_at="2026-11-02T12:00")
    with pytest.raises(Validation):
        inventory_offsale(order_id, payload, seeded_db, DEV_USERS["admin"])
    seeded_db.rollback()
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order_id)).all()
    assert all((event.form_extra or {}).get("operation_type") != "UNLIST" for event in events)
    assert seeded_db.get(Order, order_id).status == "ACTIVE"
    assert seeded_db.get(Account, account_id).status == "WAITING"


def test_system_offsale_cancels_order_and_unlists_platform(seeded_db):
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "atomic-success", "game_type": "王者荣耀"})
    register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
        form_extra={"consignment_platforms": ["测试平台"]})
    payload = schemas.InventoryOffsaleIn(reason="结束代挂", occurred_on=date(2026, 11, 2), unlisted_at="2026-11-02T12:00")
    assert inventory_offsale(order.id, payload, seeded_db, DEV_USERS["admin"]) == {"ok": True}
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()
    unlisted = [event for event in events if (event.form_extra or {}).get("operation_type") == "UNLIST"]
    assert len(unlisted) == 1
    assert unlisted[0].form_extra["platform_unlisted_at"] == "2026-11-02T12:00"
    assert order.status == "CANCELLED"
    assert seeded_db.get(Account, order.account_id).status == "VOID"


def test_system_offsale_does_not_repeat_whitespace_platform_unlisting(seeded_db):
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "whitespace-offsale", "game_type": "王者荣耀"})
    listing, _ = register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
        form_extra={"consignment_platforms": [" 测试平台 "]})
    platform_unlist_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 2), actor="pytest",
        form_extra={"consignment_event_id": listing.id, "consignment_platforms": ["测试平台"]})
    payload = schemas.InventoryOffsaleIn(reason="结束代挂", occurred_on=date(2026, 11, 3), unlisted_at="2026-11-03T12:00")
    inventory_offsale(order.id, payload, seeded_db, DEV_USERS["admin"])
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()
    unlisted = [event for event in events if (event.form_extra or {}).get("operation_type") == "UNLIST"]
    assert len(unlisted) == 1
    assert order.status == "CANCELLED"


def test_other_platform_unlisting_does_not_hide_remaining_platform(seeded_db):
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "renamed-platform", "game_type": "王者荣耀"})
    listing, _ = register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
        form_extra={"consignment_platforms": ["旧平台"]})
    post_event(seeded_db, order.id, event_type="OPERATE", operation_type="UNLIST", occurred_on=date(2026, 11, 1),
        actor="pytest", form_extra={"platform_unlist_scope": "PLATFORM", "consignment_event_id": listing.id, "consignment_platforms": ["旧平台"]})
    listing.form_extra = {**listing.form_extra, "consignment_platforms": ["新平台"]}
    seeded_db.flush()
    payload = schemas.InventoryOffsaleIn(reason="结束代挂", occurred_on=date(2026, 11, 2), unlisted_at="2026-11-02T12:00")
    inventory_offsale(order.id, payload, seeded_db, DEV_USERS["admin"])
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()
    assert sum((event.form_extra or {}).get("operation_type") == "UNLIST" for event in events) == 2


def test_recovery_offsale_rolls_back_unlisting_when_refund_invalid(seeded_db):
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "atomic-recovery", "game_type": "王者荣耀"})
    buy, _ = post_event(seeded_db, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 11, 1), actor="pytest")
    register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
        form_extra={"consignment_platforms": ["测试平台"]})
    seeded_db.commit()
    order_id, account_id, buy_id = order.id, order.account_id, buy.id
    payload = schemas.InventoryOffsaleIn(reason="出库", occurred_on=date(2026, 11, 2),
        unlisted_at="2026-11-02T12:00", amount="200", pool_id=buy.pool_id, offset_event_id=buy_id)
    with pytest.raises(Validation):
        inventory_offsale(order_id, payload, seeded_db, DEV_USERS["admin"])
    seeded_db.rollback()
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order_id)).all()
    assert all((event.form_extra or {}).get("operation_type") != "UNLIST" for event in events)
    assert seeded_db.get(Account, account_id).status == "WAITING"


def test_recovery_offsale_unlists_and_reverses_buy(seeded_db):
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "atomic-recovery-success", "game_type": "王者荣耀"})
    buy, _ = post_event(seeded_db, order.id, event_type="BUY", amount="100", occurred_on=date(2026, 11, 1), actor="pytest")
    register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
        form_extra={"consignment_platforms": ["测试平台"]})
    payload = schemas.InventoryOffsaleIn(reason="出库", occurred_on=date(2026, 11, 2),
        unlisted_at="2026-11-02T12:00", amount="100", pool_id=buy.pool_id, offset_event_id=buy.id)
    assert inventory_offsale(order.id, payload, seeded_db, DEV_USERS["admin"]) == {"ok": True}
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all()
    unlisting = next(event for event in events if (event.form_extra or {}).get("operation_type") == "UNLIST")
    assert unlisting.form_extra["platform_unlist_scope"] == "PLATFORM"
    assert unlisting.form_extra["consignment_platforms"] == ["测试平台"]
    assert any(event.event_type == "CANCEL" and event.offset_event_id == buy.id for event in events)
    assert seeded_db.get(Account, order.account_id).status == "VOID"


def test_http_failure_rolls_back_and_retry_succeeds(seeded_db, seeded_client, headers):
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "atomic-http", "game_type": "王者荣耀"})
    register_consignment(seeded_db, order.id, occurred_on=date(2026, 11, 1), actor="pytest",
        form_extra={"consignment_platforms": ["测试平台"]})
    seeded_db.commit()
    order_id = order.id

    def transactional_db():
        try:
            yield seeded_db
            seeded_db.commit()
        except Exception:
            seeded_db.rollback()
            raise

    seeded_client.app.dependency_overrides[get_db] = transactional_db
    payload = {"reason": " ", "occurred_on": "2026-11-02", "unlisted_at": "2026-11-02T12:00"}
    response = seeded_client.post(f"/api/v1/orders/{order_id}/inventory-offsale", json=payload, headers=headers)
    assert response.status_code >= 400
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order_id)).all()
    assert all((event.form_extra or {}).get("operation_type") != "UNLIST" for event in events)
    payload["reason"] = "结束代挂"
    response = seeded_client.post(f"/api/v1/orders/{order_id}/inventory-offsale", json=payload, headers=headers)
    assert response.status_code == 200, response.text
    assert seeded_db.get(Order, order_id).status == "CANCELLED"
    response = seeded_client.post(f"/api/v1/orders/{order_id}/inventory-offsale", json=payload, headers=headers)
    assert response.status_code >= 400
    events = seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order_id)).all()
    assert sum((event.form_extra or {}).get("operation_type") == "UNLIST" for event in events) == 1


@pytest.mark.parametrize("timestamp", ["无效时间", "2026-11-03T12:00", "2026-11-02T12:00+08:00"])
def test_http_rejects_invalid_offsale_timestamp(seeded_db, seeded_client, headers, timestamp):
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "invalid-offsale-time", "game_type": "王者荣耀"})
    response = seeded_client.post(f"/api/v1/orders/{order.id}/inventory-offsale", headers=headers,
        json={"reason": "结束代挂", "occurred_on": "2026-11-02", "unlisted_at": timestamp})
    assert response.status_code in (400, 422)
    assert order.status == "ACTIVE"


def test_http_requires_order_update_permission(seeded_db, seeded_client):
    order = create_order(seeded_db, order_type="DG", trade_date=date(2026, 11, 1),
        actor="pytest", account_snapshot={"game_account": "off-sale-no-permission", "game_type": "王者荣耀"})
    response = seeded_client.post(f"/api/v1/orders/{order.id}/inventory-offsale",
        headers={"X-Dev-User": "finance"}, json={"reason": "结束代挂", "occurred_on": "2026-11-02", "unlisted_at": "2026-11-02T12:00"})
    assert response.status_code == 403
    assert order.status == "ACTIVE"
