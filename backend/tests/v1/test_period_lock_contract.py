"""FIN-05-02 月结锁定契约测试。"""
from __future__ import annotations

from datetime import date

from app.stocks import service as stocks_service
from app.orders import service as orders_service


def test_period_lock_blocks_cashflow_and_event_writes(seeded_client, seeded_db, headers):
    locked = seeded_client.post(
        "/api/v1/period-locks",
        json={"period": "2026-10", "note": "月结已完成"},
        headers=headers,
    )
    assert locked.status_code == 201, locked.text
    assert locked.json()["period"] == "2026-10"

    duplicate = seeded_client.post(
        "/api/v1/period-locks",
        json={"period": "2026-10"},
        headers=headers,
    )
    assert duplicate.status_code == 409, duplicate.text

    cashflow = seeded_client.post(
        "/api/v1/cashflows",
        json={
            "pool_id": 1,
            "occurred_on": "2026-10-17",
            "direction": "IN",
            "nature": "EXTERNAL_IN",
            "category": "OTHER",
            "amount": "100.00",
            "note": "锁定月测试",
        },
        headers=headers,
    )
    assert cashflow.status_code == 409, cashflow.text
    assert cashflow.json()["code"] == "PERIOD_LOCKED"

    account = stocks_service.create_account(
        seeded_db,
        game_account="period-lock-account",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    order = orders_service.create_order(
        seeded_db,
        order_type="HS",
        trade_date=date(2026, 10, 17),
        account_id=account.id,
        actor="pytest",
    )
    event = seeded_client.post(
        f"/api/v1/orders/{order.id}/events",
        json={
            "event_type": "BUY",
            "amount": "100.00",
            "occurred_on": "2026-10-17",
        },
        headers=headers,
    )
    assert event.status_code == 409, event.text
    assert event.json()["code"] == "PERIOD_LOCKED"


def test_period_lock_list_is_readable(seeded_client, headers):
    created = seeded_client.post(
        "/api/v1/period-locks",
        json={"period": "2026-09"},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    listed = seeded_client.get("/api/v1/period-locks", headers=headers)
    assert listed.status_code == 200, listed.text
    assert listed.json()[0]["period"] == "2026-09"
