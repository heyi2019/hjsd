"""活字段在所有业务实体上的读写闭环契约。"""
from __future__ import annotations

from datetime import date

from app.foundation import service as foundation_service
from app.orders import service as orders_service
from app.parties import service as parties_service


TODAY = date(2026, 10, 17)


def _field(db, entity_type: str, field_key: str):
    return parties_service.create_field_definition(
        db,
        entity_type=entity_type,
        field_key=field_key,
        label=field_key,
        actor="pytest",
    )


def test_supported_live_field_entities_round_trip_through_api(
    seeded_client, seeded_db, headers
):
    _field(seeded_db, "pool", "pool_note")
    _field(seeded_db, "counterparty", "counterparty_note")
    _field(seeded_db, "lead", "lead_note")
    _field(seeded_db, "cashflow", "cashflow_note")
    _field(seeded_db, "installment", "installment_note")

    pool_created = seeded_client.post(
        "/api/v1/pools",
        json={
            "code": "LIVEPOOL",
            "name": "活字段池",
            "extra_values": {"pool_note": "主池"},
        },
        headers=headers,
    )
    assert pool_created.status_code == 201, pool_created.text
    pool = pool_created.json()
    assert pool["extra_values"] == {"pool_note": "主池"}
    pool_list = seeded_client.get("/api/v1/pools", headers=headers)
    assert any(item["extra_values"] == {"pool_note": "主池"} for item in pool_list.json())
    pool_updated = seeded_client.patch(
        f"/api/v1/pools/{pool['id']}",
        json={"extra_values": {"pool_note": "已更新"}},
        headers=headers,
    )
    assert pool_updated.status_code == 200, pool_updated.text
    assert pool_updated.json()["extra_values"] == {"pool_note": "已更新"}

    counterparty_created = seeded_client.post(
        "/api/v1/counterparties",
        json={
            "display_name": "活字段同行",
            "type": "PEER",
            "extra_values": {"counterparty_note": "重点"},
        },
        headers=headers,
    )
    assert counterparty_created.status_code == 201, counterparty_created.text
    counterparty = counterparty_created.json()
    assert counterparty["extra_values"] == {"counterparty_note": "重点"}
    counterparty_list = seeded_client.get("/api/v1/counterparties", headers=headers)
    assert any(
        item["extra_values"] == {"counterparty_note": "重点"}
        for item in counterparty_list.json()
    )
    counterparty_updated = seeded_client.patch(
        f"/api/v1/counterparties/{counterparty['id']}",
        json={"extra_values": {"counterparty_note": "已更新"}},
        headers=headers,
    )
    assert counterparty_updated.status_code == 200, counterparty_updated.text
    assert counterparty_updated.json()["extra_values"] == {"counterparty_note": "已更新"}

    customer = parties_service.create_customer(
        seeded_db, display_name="活字段需求客户", actor="pytest"
    )
    lead_created = seeded_client.post(
        "/api/v1/leads",
        json={
            "customer_id": customer.id,
            "request_type": "FIND_ACCOUNT",
            "target": "找一款游戏账号",
            "extra_values": {"lead_note": "高优先级"},
        },
        headers=headers,
    )
    assert lead_created.status_code == 201, lead_created.text
    lead = lead_created.json()
    assert lead["extra_values"] == {"lead_note": "高优先级"}
    lead_list = seeded_client.get("/api/v1/leads", headers=headers)
    assert any(item["extra_values"] == {"lead_note": "高优先级"} for item in lead_list.json())
    lead_updated = seeded_client.patch(
        f"/api/v1/leads/{lead['id']}",
        json={"extra_values": {"lead_note": "已跟进"}},
        headers=headers,
    )
    assert lead_updated.status_code == 200, lead_updated.text
    assert lead_updated.json()["extra_values"] == {"lead_note": "已跟进"}

    cashflow_created = seeded_client.post(
        "/api/v1/cashflows",
        json={
            "pool_id": pool["id"],
            "occurred_on": TODAY.isoformat(),
            "direction": "OUT",
            "nature": "BUSINESS_OUT",
            "category": "OTHER",
            "amount": "10.00",
            "extra_values": {"cashflow_note": "测试支出"},
        },
        headers=headers,
    )
    assert cashflow_created.status_code == 201, cashflow_created.text
    cashflow = cashflow_created.json()
    assert cashflow["extra_values"] == {"cashflow_note": "测试支出"}
    cashflow_list = seeded_client.get("/api/v1/cashflows", headers=headers)
    assert any(
        item["extra_values"] == {"cashflow_note": "测试支出"}
        for item in cashflow_list.json()
    )

    order = orders_service.create_order(
        seeded_db,
        order_type="DFQ",
        trade_date=TODAY,
        customer_roles=[(customer.id, "INSTALLMENT_CUSTOMER")],
        actor="pytest",
    )
    installment_created = seeded_client.post(
        "/api/v1/installments",
        json={
            "order_id": order.id,
            "contract_type": "ADVANCE_PURCHASE",
            "principal": "100.00",
            "down_payment": "50.00",
            "periods": 1,
            "per_period": "50.00",
            "first_due_on": TODAY.isoformat(),
            "extra_values": {"installment_note": "按期收款"},
        },
        headers=headers,
    )
    assert installment_created.status_code == 201, installment_created.text
    installment = installment_created.json()
    assert installment["extra_values"] == {"installment_note": "按期收款"}
    installment_list = seeded_client.get("/api/v1/installments", headers=headers)
    assert any(
        item["extra_values"] == {"installment_note": "按期收款"}
        for item in installment_list.json()
    )
