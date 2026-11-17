"""MASTER-01 T02 / BAS-02 API：业务类型主数据与零本金规则。"""
from __future__ import annotations

from app.core.errors import ErrorCode
from app.field_definitions.classification import classification_for_order_type

ORDER_TYPES = "/api/v1/order-types"


def test_business_classification_is_fixed_per_order_type():
    assert classification_for_order_type("HS") == {
        "business_mode": "SELF",
        "business_type": "RECOVERY",
        "value_added_service": None,
    }
    assert classification_for_order_type("TH")["business_mode"] == "DISTRIBUTION"
    assert classification_for_order_type("DG")["business_type"] == "CONSIGNMENT"


def test_create_business_is_immediately_usable(client, headers, seeded_db):
    """BAS-02-02（2026-11-17）：删除资金路由后，新建业务直接可用，无需先配路由。"""
    created = client.post(
        ORDER_TYPES,
        json={"code": "TB", "name": "同行代收"},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["is_active"] is True
    assert body["is_zero_principal"] is False
    assert body["sequence_prefix"] == "TB"

    disabled = client.patch(f"{ORDER_TYPES}/{body['id']}/active?is_active=false", headers=headers)
    assert disabled.status_code == 200
    assert disabled.json()["is_active"] is False


def test_zero_principal_flag_can_be_set_on_create(client, headers):
    created = client.post(
        ORDER_TYPES,
        json={"code": "ZP", "name": "零本金测试", "is_zero_principal": True},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    assert created.json()["is_zero_principal"] is True


def test_new_sequence_created_with_business(client, headers):
    client.post(
        ORDER_TYPES, json={"code": "TB", "name": "同行代收"}, headers=headers
    )
    sequences = client.get("/api/v1/sequences", headers=headers).json()
    assert any(item["sequence_key"] == "ORDER_TB" and item["next_number"] == "TB0001" for item in sequences)


def test_duplicate_business_code_returns_422(client, seeded_db, headers):
    response = client.post(
        ORDER_TYPES, json={"code": "HS", "name": "重复回收"}, headers=headers
    )
    assert response.status_code == 422
    assert response.json()["code"] == ErrorCode.DUPLICATE_CODE


def test_seeded_business_visible(client, seeded_db, headers):
    body = client.get(ORDER_TYPES, headers=headers).json()
    codes = {item["code"] for item in body}
    assert {"HS", "TH", "DG"} <= codes
    by_code = {item["code"]: item for item in body}
    assert by_code["HS"]["business_mode"] == "SELF"
    assert by_code["TH"]["business_mode"] == "DISTRIBUTION"
    assert by_code["DG"]["business_type"] == "CONSIGNMENT"
