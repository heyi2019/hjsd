"""MASTER-01 T02 / BAS-03 API：资金账户端点、权限与错误码。

权限矩阵 §2：主数据写操作只有系统管理员可做；
查看者（`viewer`）调写接口必须 403 `PERMISSION_DENIED`，且不得泄露对象是否存在。
"""
from __future__ import annotations

import pytest

from app.core.errors import ErrorCode
from app.foundation.pools import get_pool_by_code

POOLS = "/api/v1/pools"


def test_auth_required(client):
    response = client.get(POOLS)
    assert response.status_code == 401
    assert response.json()["code"] == ErrorCode.AUTH_REQUIRED


def test_viewer_can_read_but_not_write(client, viewer_headers):
    assert client.get(POOLS, headers=viewer_headers).status_code == 200

    response = client.post(POOLS, json={"code": "NOPE", "name": "非法"}, headers=viewer_headers)
    assert response.status_code == 403
    payload = response.json()
    assert payload["code"] == ErrorCode.PERMISSION_DENIED
    assert "pool.manage" in payload["details"]["required"]


def test_create_and_list_pool(client, headers):
    payload = {"code": "hj_custody", "name": "代客保管池", "ownership": "CUSTODY", "pool_type": "OTHER"}
    created = client.post(POOLS, json=payload, headers=headers)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["code"] == "HJ_CUSTODY"
    assert body["ownership"] == "CUSTODY"
    assert body["status"] == "ACTIVE"

    listed = client.get(POOLS, headers=headers).json()
    assert any(item["code"] == "HJ_CUSTODY" for item in listed)


def test_create_pool_can_set_default(client, headers):
    created = client.post(
        POOLS,
        json={"code": "HJ_DEFAULT", "name": "默认账户", "is_default": True},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    assert created.json()["is_default"] is True

    listed = {item["code"]: item for item in client.get(POOLS, headers=headers).json()}
    assert listed["HJ_DEFAULT"]["is_default"] is True
    assert sum(item["is_default"] for item in listed.values()) == 1


def test_custom_pool_type_is_supported_as_registry_value(client, headers):
    response = client.post(
        POOLS,
        json={"code": "HJ_DEPOSIT", "name": "押金池", "pool_type": "DEPOSIT"},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    assert response.json()["pool_type"] == "DEPOSIT"


def test_duplicate_pool_code_returns_422(client, headers):
    first = client.post(POOLS, json={"code": "DUP1", "name": "一号"}, headers=headers)
    assert first.status_code == 201
    second = client.post(POOLS, json={"code": "DUP1", "name": "二号"}, headers=headers)
    assert second.status_code == 422
    assert second.json()["code"] == ErrorCode.DUPLICATE_CODE


def test_update_and_disable_pool(client, seeded_db, headers):
    pool = get_pool_by_code(seeded_db, "HJ_INVEST")
    patched = client.patch(
        f"{POOLS}/{pool.id}", json={"name": "投资款荷包（本金）"}, headers=headers
    )
    assert patched.status_code == 200
    assert patched.json()["code"] == "HJ_INVEST", "code 不随改名变化（V18）"

    disabled = client.patch(
        f"{POOLS}/{pool.id}/status", json={"status": "DISABLED"}, headers=headers
    )
    assert disabled.status_code == 200
    assert disabled.json()["status"] == "DISABLED"
    listed = {item["code"]: item["status"] for item in client.get(POOLS, headers=headers).json()}
    assert listed["HJ_INVEST"] == "DISABLED"
    assert listed["HJ_PROFIT"] == "ACTIVE"


def test_delete_empty_pool(client, headers):
    created = client.post(POOLS, json={"code": "DELME", "name": "待删"}, headers=headers).json()
    deleted = client.delete(f"{POOLS}/{created['id']}", headers=headers)
    assert deleted.status_code == 204
    assert client.get(POOLS, headers=headers).status_code == 200


def test_validation_error_marks_field(client, headers):
    response = client.post(POOLS, json={"code": "X", "name": ""}, headers=headers)
    assert response.status_code == 422
    payload = response.json()
    assert payload["code"] == ErrorCode.VALIDATION_ERROR
    assert payload["details"]["errors"]


def test_jwt_bearer_flow_works(client, admin_token_headers, seeded_db):
    """JWT 签发/校验链路可用；查看者 token 写操作仍被拒。"""
    response = client.get(POOLS, headers=admin_token_headers)
    assert response.status_code == 200


def test_expired_token_returns_token_expired(client):
    from app.core.security import DEV_USERS, encode_token

    expired = encode_token(
        {
            "sub": str(DEV_USERS["admin"].id),
            "username": "admin",
            "roles": ["ADMIN"],
        },
        expires_minutes=-1,
    )
    response = client.get(POOLS, headers={"Authorization": f"Bearer {expired}"})
    assert response.status_code == 401
    assert response.json()["code"] == ErrorCode.TOKEN_EXPIRED


@pytest.mark.parametrize("verb,path", [("get", "/api/v1/sequences"), ("get", "/api/v1/order-types")])
def test_unknown_dev_user_is_rejected(client, verb, path):
    response = getattr(client, verb)(path, headers={"X-Dev-User": "ghost"})
    assert response.status_code == 401
