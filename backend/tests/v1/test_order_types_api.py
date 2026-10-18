"""T02 / BAS-02 API：业务类型主数据与资金路由配置。"""
from __future__ import annotations

from app.core.errors import ErrorCode
from app.foundation.classification import classification_for_order_type

ORDER_TYPES = "/api/v1/order-types"


def test_fixed_business_classification_is_not_inferred_from_capital_type():
    assert classification_for_order_type("HS") == {
        "business_mode": "SELF",
        "business_type": "RECOVERY",
        "value_added_service": None,
    }
    assert classification_for_order_type("TH")["business_mode"] == "DISTRIBUTION"
    assert classification_for_order_type("DG")["business_type"] == "CONSIGNMENT"
    assert classification_for_order_type("DFQ")["value_added_service"] == "ADVANCE_PURCHASE"


def test_create_business_then_route_then_activate(client, headers, seeded_db):
    """BAS-02-02：新业务必须“先配路由、再启用”，否则 TB0001 无法生成。"""
    created = client.post(
        ORDER_TYPES,
        json={"code": "TB", "name": "同行代收", "capital_type": "STOCK"},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["is_active"] is False
    assert body["sequence_prefix"] == "TB"

    activate = client.patch(f"{ORDER_TYPES}/{body['id']}/active?is_active=true", headers=headers)
    assert activate.status_code == 422
    assert activate.json()["code"] == ErrorCode.POOL_ROUTE_MISSING

    routed = client.post(
        f"{ORDER_TYPES}/TB/routes",
        json={"portion": "PROFIT", "pool_code": "HJ_PROFIT"},
        headers=headers,
    )
    assert routed.status_code == 201, routed.text
    assert routed.json()["pool_code"] == "HJ_PROFIT"

    activated = client.patch(f"{ORDER_TYPES}/{body['id']}/active?is_active=true", headers=headers)
    assert activated.status_code == 200
    assert activated.json()["is_active"] is True


def test_new_sequence_created_with_business(client, headers):
    client.post(
        ORDER_TYPES, json={"code": "TB", "name": "同行代收", "capital_type": "STOCK"}, headers=headers
    )
    sequences = client.get("/api/v1/sequences", headers=headers).json()
    assert any(item["sequence_key"] == "ORDER_TB" and item["next_number"] == "TB0001" for item in sequences)


def test_pass_thru_capital_type_is_removed(client, headers):
    response = client.post(
        ORDER_TYPES,
        json={"code": "TP", "name": "不应存在的资金分类", "capital_type": "PASS_THRU"},
        headers=headers,
    )
    assert response.status_code == 422, response.text


def test_route_upsert_is_idempotent(client, seeded_db, headers):
    first = client.post(
        f"{ORDER_TYPES}/HS/routes",
        json={"portion": "PRINCIPAL", "pool_code": "HJ_PROFIT"},
        headers=headers,
    )
    second = client.post(
        f"{ORDER_TYPES}/HS/routes",
        json={"portion": "PRINCIPAL", "pool_code": "HJ_PROFIT"},
        headers=headers,
    )
    assert first.status_code == 201 and second.status_code == 201
    routes = client.get(f"{ORDER_TYPES}/1/routes", headers=headers).json()
    principal_routes = [item for item in routes if item["portion"] == "PRINCIPAL"]
    assert len(principal_routes) == 1


def test_route_can_be_keyed_by_fund_nature(client, seeded_db, headers):
    response = client.post(
        f"{ORDER_TYPES}/HS/routes",
        json={"portion": "PRINCIPAL", "fund_nature": "BUSINESS", "pool_code": "HJ_PROFIT"},
        headers=headers,
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["portion"] == "PRINCIPAL"
    assert body["fund_nature"] == "BUSINESS"
    assert body["pool_code"] == "HJ_PROFIT"

    routes = client.get(f"{ORDER_TYPES}/1/routes", headers=headers).json()
    assert len(
        [
            item
            for item in routes
            if item["portion"] == "PRINCIPAL" and item["fund_nature"] == "BUSINESS"
        ]
    ) == 1


def test_unknown_business_route_returns_404(client, headers):
    response = client.post(
        f"{ORDER_TYPES}/ZZ/routes", json={"portion": "PROFIT", "pool_code": "HJ_PROFIT"}, headers=headers
    )
    assert response.status_code == 404
    assert response.json()["code"] == ErrorCode.RESOURCE_NOT_FOUND


def test_duplicate_business_code_returns_422(client, seeded_db, headers):
    response = client.post(
        ORDER_TYPES, json={"code": "HS", "name": "重复回收", "capital_type": "STOCK"}, headers=headers
    )
    assert response.status_code == 422
    assert response.json()["code"] == ErrorCode.DUPLICATE_CODE


def test_seeded_business_visible(client, seeded_db, headers):
    body = client.get(ORDER_TYPES, headers=headers).json()
    codes = {item["code"] for item in body}
    assert {"HS", "TH", "DG", "DFQ"} <= codes
    by_code = {item["code"]: item for item in body}
    assert by_code["HS"]["business_mode"] == "SELF"
    assert by_code["TH"]["business_mode"] == "DISTRIBUTION"
    assert by_code["DG"]["business_type"] == "CONSIGNMENT"
    assert by_code["DFQ"]["value_added_service"] == "ADVANCE_PURCHASE"
