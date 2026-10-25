"""CUS-02 客户需求池契约测试。"""
from __future__ import annotations

from datetime import date

from app.orders import service as orders_service
from app.parties import service as parties_service


def test_lead_lifecycle_and_manual_order_conversion(seeded_client, seeded_db, headers):
    customer = parties_service.create_customer(
        seeded_db, display_name="需求客户", owner_id=9, actor="pytest"
    )

    created = seeded_client.post(
        "/api/v1/leads",
        json={
            "customer_id": customer.id,
            "request_type": "FIND_ACCOUNT",
            "budget": "2000.00",
            "target": "王者荣耀 安卓区",
            "note": "优先找带二次号",
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    lead = created.json()
    assert lead["lead_no"].startswith("REQ")
    assert lead["status"] == "OPEN"

    listed = seeded_client.get(
        "/api/v1/leads",
        params={"customer_id": customer.id, "status": "OPEN"},
        headers=headers,
    )
    assert listed.status_code == 200, listed.text
    assert [item["lead_no"] for item in listed.json()] == [lead["lead_no"]]

    updated = seeded_client.patch(
        f"/api/v1/leads/{lead['id']}",
        json={"budget": "2500.00", "target": "王者荣耀 安卓区 需要可换绑"},
        headers=headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["budget"] == "2500.00"

    order = orders_service.create_order(
        seeded_db, order_type="DFQ", trade_date=date(2026, 10, 17), actor="pytest"
    )
    converted = seeded_client.post(
        f"/api/v1/leads/{lead['id']}/convert",
        json={"order_id": order.id},
        headers=headers,
    )
    assert converted.status_code == 200, converted.text
    assert converted.json()["status"] == "CONVERTED"
    assert converted.json()["converted_order_id"] == order.id


def test_lead_close_does_not_create_order_or_cashflow(seeded_client, seeded_db, headers):
    customer = parties_service.create_customer(
        seeded_db, display_name="关闭需求客户", owner_id=9, actor="pytest"
    )
    created = seeded_client.post(
        "/api/v1/leads",
        json={
            "customer_id": customer.id,
            "request_type": "SELL_ACCOUNT",
            "target": "暂不出售",
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text

    closed = seeded_client.post(
        f"/api/v1/leads/{created.json()['id']}/close",
        json={"reason": "客户暂缓"},
        headers=headers,
    )
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "CLOSED"
    assert closed.json()["converted_order_id"] is None


def test_get_lead_endpoint_returns_lead(seeded_client, seeded_db, headers):
    customer = parties_service.create_customer(
        seeded_db, display_name="查询需求客户", owner_id=9, actor="pytest"
    )
    created = seeded_client.post(
        "/api/v1/leads",
        json={"customer_id": customer.id, "request_type": "FIND_ACCOUNT", "target": "测试"},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    lead_id = created.json()["id"]
    response = seeded_client.get(f"/api/v1/leads/{lead_id}", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["lead_no"] == created.json()["lead_no"]


def test_update_lead_rejects_owner_transfer_for_scoped_user(seeded_client, seeded_db, headers):
    from app.core.security import CurrentUser, build_access_token

    customer = parties_service.create_customer(
        seeded_db, display_name="转交需求客户", owner_id=9, actor="pytest"
    )
    created = seeded_client.post(
        "/api/v1/leads",
        json={"customer_id": customer.id, "request_type": "FIND_ACCOUNT", "target": "测试"},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    lead_id = created.json()["id"]
    operator = CurrentUser.build(
        id=9, username="op", roles=["OPERATOR"], owner_scope="SELF"
    )
    op_headers = {"Authorization": f"Bearer {build_access_token(operator)}"}
    response = seeded_client.patch(
        f"/api/v1/leads/{lead_id}", json={"owner_id": 9}, headers=op_headers
    )
    assert response.status_code == 403, response.text
