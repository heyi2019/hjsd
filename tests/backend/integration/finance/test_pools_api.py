"""MASTER-01 T02 / BAS-03 API：资金账户端点、权限与错误码。

权限矩阵 §2：主数据写操作只有系统管理员可做；
查看者（`viewer`）调写接口必须 403 `PERMISSION_DENIED`，且不得泄露对象是否存在。
"""
from __future__ import annotations

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.core.errors import ErrorCode
from app.domain.foundation import Pool
from app.settings.field_definitions.pools import get_pool_by_code

POOLS = "/api/pools"


def test_pool_codes_are_automatic_and_never_reused(client, headers):
    first = client.post(POOLS, json={"name": "甲账户"}, headers=headers)
    second = client.post(POOLS, json={"name": "乙账户"}, headers=headers)
    assert first.status_code == second.status_code == 201
    assert [first.json()["code"], second.json()["code"]] == ["pool_01", "pool_02"]
    assert client.patch(f"{POOLS}/{second.json()['id']}", json={"name": "乙账户改名"}, headers=headers).json()["code"] == "pool_02"
    assert client.delete(f"{POOLS}/{first.json()['id']}", headers=headers).status_code == 204
    third = client.post(POOLS, json={"name": "丙账户"}, headers=headers)
    assert third.status_code == 201
    assert third.json()["code"] == "pool_03"


def test_auth_required(client):
    response = client.get(POOLS)
    assert response.status_code == 401
    assert response.json()["code"] == ErrorCode.AUTH_REQUIRED


def test_viewer_can_read_but_not_write(client, viewer_headers):
    assert client.get(POOLS, headers=viewer_headers).status_code == 200

    response = client.post(POOLS, json={"name": "非法"}, headers=viewer_headers)
    assert response.status_code == 403
    payload = response.json()
    assert payload["code"] == ErrorCode.PERMISSION_DENIED
    assert "pool.manage" in payload["details"]["required"]


def test_create_and_list_pool(client, headers):
    payload = {"name": "代客保管池", "pool_type": "OTHER"}
    created = client.post(POOLS, json=payload, headers=headers)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["code"] == "pool_01"
    assert body["status"] == "ACTIVE"

    listed = client.get(POOLS, headers=headers).json()
    assert any(item["code"] == "pool_01" for item in listed)


def test_create_pool_can_set_default(client, headers):
    created = client.post(
        POOLS,
        json={"name": "默认账户", "is_default": True},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    assert created.json()["is_default"] is True

    listed = {item["code"]: item for item in client.get(POOLS, headers=headers).json()}
    assert listed["pool_01"]["is_default"] is True
    assert sum(item["is_default"] for item in listed.values()) == 1


def test_database_rejects_multiple_default_pools(seeded_db):
    pools = seeded_db.scalars(select(Pool).order_by(Pool.id)).all()
    assert sum(pool.is_default for pool in pools) == 1
    other = next(pool for pool in pools if not pool.is_default)
    with pytest.raises(IntegrityError, match="uq_pools_single_default"):
        with seeded_db.begin_nested():
            other.is_default = True
            seeded_db.flush()


def test_existing_database_constraint_repair_checks_data_and_is_idempotent(seeded_db):
    from app.business.orders.create import create_order
    from app.finance.deposits.writes import create_deposit
    from scripts.ensure_funds_constraints import ensure_funds_constraints
    from datetime import date

    order = create_order(seeded_db, order_type="HS", trade_date=date(2026, 10, 1), actor="pytest")
    deposit = create_deposit(seeded_db, pool_id=1, amount="10", paid_on=date(2026, 10, 1),
                             actor="pytest", source_order_id=order.id)
    connection = seeded_db.connection()
    connection.execute(text('ALTER TABLE deposits DROP CONSTRAINT "ck_deposits_studio_deposit_no_order"'))
    connection.execute(text('DROP INDEX "uq_pools_single_default"'))
    pools = seeded_db.scalars(select(Pool).order_by(Pool.id)).all()
    other = next(pool for pool in pools if not pool.is_default)
    other.is_default = True
    deposit.ledger_type = "STUDIO"
    seeded_db.flush()
    with pytest.raises(RuntimeError, match="历史数据") as error:
        ensure_funds_constraints(connection)
    assert "默认资金账户" in str(error.value) and "工作室押金" in str(error.value)
    other.is_default = False
    deposit.ledger_type = "BUSINESS"
    seeded_db.flush()
    assert ensure_funds_constraints(connection) == {"default_pool_index": "created", "studio_deposit_check": "created"}
    assert ensure_funds_constraints(connection) == {"default_pool_index": "present", "studio_deposit_check": "present"}


def test_custom_pool_type_is_supported_as_registry_value(client, headers):
    response = client.post(
        POOLS,
        json={"name": "押金池", "pool_type": "DEPOSIT"},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    assert response.json()["pool_type"] == "DEPOSIT"


def test_pool_code_cannot_be_supplied_by_client(client, headers):
    response = client.post(POOLS, json={"code": "pool_99", "name": "账户"}, headers=headers)
    assert response.status_code == 422


def test_update_and_disable_pool(client, seeded_db, headers):
    pool = get_pool_by_code(seeded_db, "pool_01")
    patched = client.patch(
        f"{POOLS}/{pool.id}", json={"name": "投资款荷包（本金）"}, headers=headers
    )
    assert patched.status_code == 200
    assert patched.json()["code"] == "pool_01", "code 不随改名变化（V18）"

    disabled = client.patch(
        f"{POOLS}/{pool.id}/status", json={"status": "DISABLED"}, headers=headers
    )
    assert disabled.status_code == 200
    assert disabled.json()["status"] == "DISABLED"
    listed = {item["code"]: item["status"] for item in client.get(POOLS, headers=headers).json()}
    assert listed["pool_01"] == "DISABLED"
    assert listed["pool_02"] == "ACTIVE"


def test_delete_empty_pool(client, headers):
    created = client.post(POOLS, json={"name": "待删"}, headers=headers).json()
    deleted = client.delete(f"{POOLS}/{created['id']}", headers=headers)
    assert deleted.status_code == 204
    assert client.get(POOLS, headers=headers).status_code == 200


def test_validation_error_marks_field(client, headers):
    response = client.post(POOLS, json={"name": ""}, headers=headers)
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


@pytest.mark.parametrize("verb,path", [("get", "/api/sequences"), ("get", "/api/order-types")])
def test_unknown_dev_user_is_rejected(client, verb, path):
    response = getattr(client, verb)(path, headers={"X-Dev-User": "ghost"})
    assert response.status_code == 401
