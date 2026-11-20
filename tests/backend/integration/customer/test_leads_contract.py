"""PARTY-01 CUS-02 客户需求池契约测试。"""
from __future__ import annotations

from datetime import date, datetime

import pytest

from app.business.create import create_order
from app.business.form_fields import create_order_form_field
from app.domain.trade import OrderFormField
from app.customers.customers import create_customer
from app.customers.counterparties import create_counterparty
from app.customers.leads import create_lead


def test_lead_conditional_field_can_depend_on_core_fields(seeded_client, seeded_db, headers):
    customer = create_customer(seeded_db, display_name="条件需求客户", actor="pytest")
    seeded_db.add(OrderFormField(order_type_code="LEAD", field_key="request_type", label="需求类型",
                                 field_type="SELECT", is_active=True, is_custom=False, created_by="pytest", updated_by="pytest"))
    note = create_order_form_field(seeded_db, order_type_code="LEAD", field_key="request_note",
                                   label="需求说明", actor="pytest")
    note.required_when = {"field": "request_type", "op": "eq", "values": ["FIND_ACCOUNT"]}
    seeded_db.commit()
    payload = {"customer_id": customer.id, "request_type": "FIND_ACCOUNT", "target": "测试"}
    missing = seeded_client.post("/api/v1/leads", json=payload, headers=headers)
    assert missing.status_code == 422, missing.text
    assert "request_note" in missing.text
    saved = seeded_client.post("/api/v1/leads", json={**payload, "extra_values": {"request_note": "指定条件"}}, headers=headers)
    assert saved.status_code == 201, saved.text


@pytest.mark.parametrize(("action", "scope", "dependency"), [
    ("close", "LEADCLOSE", "reason"), ("convert", "LEADCONVERT", "order_id"),
])
def test_lead_action_conditional_field_can_depend_on_core_fields(seeded_client, seeded_db, headers, action, scope, dependency):
    customer = create_customer(seeded_db, display_name="操作条件客户", actor="pytest")
    lead = create_lead(seeded_db, customer_id=customer.id, request_type="FIND_ACCOUNT", target="测试", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 17), actor="pytest")
    seeded_db.add(OrderFormField(order_type_code=scope, field_key=dependency, label="操作字段", field_type="TEXT",
                                 is_active=True, is_custom=False, created_by="pytest", updated_by="pytest"))
    note = create_order_form_field(seeded_db, order_type_code=scope, field_key="action_note", label="操作说明", actor="pytest")
    note.required_when = {"field": dependency, "op": "filled"}
    seeded_db.commit()
    payload = {"reason": "关闭"} if action == "close" else {"order_no": order.order_no}
    url = f"/api/v1/leads/{lead.id}/{action}"
    missing = seeded_client.post(url, json=payload, headers=headers)
    assert missing.status_code == 422, missing.text
    saved = seeded_client.post(url, json={**payload, "extra_values": {"action_note": "已核对"}}, headers=headers)
    assert saved.status_code == 200, saved.text


@pytest.mark.parametrize(("action", "scope", "field_key"), [
    ("close", "LEADCLOSE", "close_note"),
    ("convert", "LEADCONVERT", "convert_note"),
])
def test_lead_actions_validate_only_their_own_fields(seeded_client, seeded_db, headers, action, scope, field_key):
    customer = create_customer(seeded_db, display_name="字段配置客户", actor="pytest")
    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 17), actor="pytest")
    for field_scope, key in [("LEAD", "request_note"), ("LEADCLOSE", "close_note"), ("LEADCONVERT", "convert_note")]:
        create_order_form_field(seeded_db, order_type_code=field_scope, field_key=key,
                                label=key, required=True, actor="pytest")
    seeded_db.commit()
    payload = {"customer_id": customer.id, "request_type": "FIND_ACCOUNT", "target": "测试"}
    missing = seeded_client.post("/api/v1/leads", json=payload, headers=headers)
    assert missing.status_code == 422, missing.text
    assert "request_note" in missing.text
    created = seeded_client.post("/api/v1/leads", json={**payload, "extra_values": {"request_note": "建档凭据"}}, headers=headers)
    assert created.status_code == 201, created.text
    lead_id = created.json()["id"]
    url = f"/api/v1/leads/{lead_id}/{action}"
    action_payload = {"reason": "结束"} if action == "close" else {"order_no": order.order_no}
    missing_action = seeded_client.post(url, json=action_payload, headers=headers)
    assert missing_action.status_code == 422, missing_action.text
    assert field_key in missing_action.text
    done = seeded_client.post(url, json={**action_payload, "extra_values": {field_key: "操作凭据"}}, headers=headers)
    assert done.status_code == 200, done.text
    assert done.json()["extra_values"] == {"request_note": "建档凭据", field_key: "操作凭据"}


def test_customer_center_creation_period_filters_lists_summaries_and_export(seeded_client, seeded_db, headers):
    customers = [create_customer(seeded_db, display_name=f"周期客户{index}", actor="pytest") for index in range(2)]
    parties = [create_counterparty(seeded_db, display_name=f"周期合作方{index}", type="PEER", actor="pytest") for index in range(2)]
    leads = [create_lead(seeded_db, customer_id=customer.id, request_type="FIND_ACCOUNT", target=f"周期需求{index}", actor="pytest") for index, customer in enumerate(customers)]
    for group in (customers, parties, leads):
        group[0].created_at = datetime(2026, 12, 15, 23, 59, 59)
        group[1].created_at = datetime(2026, 12, 16, 0, 0, 0)
    seeded_db.flush()
    params = {"created_from": "2026-11-16", "created_to": "2026-12-15"}
    for path, target in (("/api/v1/customers", customers[0]), ("/api/v1/counterparties/page", parties[0]), ("/api/v1/leads/page", leads[0])):
        response = seeded_client.get(path, params=params, headers=headers)
        assert response.status_code == 200, response.text
        assert response.json()["total"] == 1
        assert [item["id"] for item in response.json()["items"]] == [target.id]
    summary = seeded_client.get("/api/v1/leads/summary", params=params, headers=headers)
    assert summary.json() == {"total_count": 1, "open_count": 1}
    exported = seeded_client.get("/api/v1/customers/export.csv", params=params, headers=headers)
    assert "周期客户0" in exported.text and "周期客户1" not in exported.text
    assert seeded_client.get("/api/v1/customers", params={"created_from": "2026-12-16", "created_to": "2026-12-15"}, headers=headers).status_code == 422


def test_lead_lifecycle_and_manual_order_conversion(seeded_client, seeded_db, headers):
    customer = create_customer(
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
    assert lead["customer_display_name"] == "需求客户"
    assert lead["customer_display_name"] == "需求客户"

    listed = seeded_client.get(
        "/api/v1/leads",
        params={"customer_id": customer.id, "status": "OPEN"},
        headers=headers,
    )
    assert listed.status_code == 200, listed.text
    assert [item["lead_no"] for item in listed.json()] == [lead["lead_no"]]
    assert listed.json()[0]["customer_display_name"] == "需求客户"

    paged = seeded_client.get(
        "/api/v1/leads/page",
        params={"limit": 10, "offset": 0},
        headers=headers,
    )
    assert paged.status_code == 200, paged.text
    page = paged.json()
    assert page["total"] == 1
    assert page["limit"] == 10
    assert page["offset"] == 0
    assert page["items"][0]["customer_display_name"] == "需求客户"
    assert listed.json()[0]["customer_display_name"] == "需求客户"

    updated = seeded_client.patch(
        f"/api/v1/leads/{lead['id']}",
        json={"budget": "2500.00", "target": "王者荣耀 安卓区 需要可换绑"},
        headers=headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["budget"] == "2500.00"

    order = create_order(
        seeded_db, order_type="HS", trade_date=date(2026, 10, 17), actor="pytest"
    )
    legacy = seeded_client.post(f"/api/v1/leads/{lead['id']}/convert", json={"order_id": order.id}, headers=headers)
    assert legacy.status_code == 422, legacy.text
    missing = seeded_client.post(f"/api/v1/leads/{lead['id']}/convert", json={"order_no": "HS-NOT-FOUND"}, headers=headers)
    assert missing.status_code == 404, missing.text
    converted = seeded_client.post(
        f"/api/v1/leads/{lead['id']}/convert",
        json={"order_no": f"  {order.order_no.lower()}  "},
        headers=headers,
    )
    assert converted.status_code == 200, converted.text
    assert converted.json()["status"] == "CONVERTED"
    assert converted.json()["converted_order_id"] == order.id


def test_lead_keyword_search_escapes_like_wildcards(seeded_client, seeded_db, headers):
    """需求目标含 `_` 时按字面匹配，不把 `_` 当单字符通配误命中。"""
    customer = create_customer(
        seeded_db, display_name="需求搜索客户", owner_id=9, actor="pytest"
    )
    hit = seeded_client.post(
        "/api/v1/leads",
        json={"customer_id": customer.id, "request_type": "FIND_ACCOUNT", "target": "王者_安卓"},
        headers=headers,
    )
    assert hit.status_code == 201, hit.text
    seeded_client.post(
        "/api/v1/leads",
        json={"customer_id": customer.id, "request_type": "FIND_ACCOUNT", "target": "王者X安卓"},
        headers=headers,
    )

    listed = seeded_client.get(
        "/api/v1/leads", params={"keyword": "王者_安卓"}, headers=headers
    )
    assert listed.status_code == 200, listed.text
    assert [item["id"] for item in listed.json()] == [hit.json()["id"]]


def test_lead_close_does_not_create_order_or_cashflow(seeded_client, seeded_db, headers):
    customer = create_customer(
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
    customer = create_customer(
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

    customer = create_customer(
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
