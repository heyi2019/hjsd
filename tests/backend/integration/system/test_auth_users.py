"""AUTH-01 auth 路由契约测试：登录 / 改密 / 登出 / 用户管理 / 团队管理。

覆盖策略：
- 登录链路用「POST /users 建号 → POST /auth/login 换 token → Bearer 调后续端点」全链路；
- 权限分支用 `X-Dev-User` 切换 dev 身份（admin 恒过、viewer 必 403）；
- 数据隔离沿用 tests/backend/conftest.py 的「跑完清库」策略，不跨用例泄漏。
"""
from __future__ import annotations

from datetime import date

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select
from app.auth import service
from app.core.errors import Validation
from app.domain.enums import AuditAction
from app.domain.foundation import AuditLog
from app.domain.trade import Order
from app.domain.users import User

def _create_user(client: TestClient, *, username: str = "alice", password: str = "password123",
                 role: str = "VIEWER") -> dict:
    response = client.post(
        "/api/v1/users",
        json={
            "username": username,
            "display_name": "测试用户",
            "password": password,
            "role": role,
        },
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 201, response.text
    return response.json()

def _login(client: TestClient, username: str, password: str) -> str:
    response = client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
    )
    assert response.status_code == 200, response.text
    return response.json()["access_token"]

def test_create_user_blank_display_name_rejected(client: TestClient):
    response = client.post(
        "/api/v1/users",
        json={
            "username": "blank-name",
            "display_name": "   ",
            "password": "password123",
        },
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 422
    assert response.json()["message"] == "显示名称不能为空"

def test_create_user_duplicate_username(client: TestClient):
    _create_user(client)
    response = client.post(
        "/api/v1/users",
        json={
            "username": "alice",
            "display_name": "另一个 Alice",
            "password": "password123",
        },
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 409

def test_create_user_with_unknown_team_ids(client: TestClient):
    response = client.post(
        "/api/v1/users",
        json={
            "username": "carol",
            "display_name": "Carol",
            "password": "password123",
            "team_ids": [999],
        },
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 422
    assert response.json()["details"]["team_ids"] == [999]

def test_create_user_with_unknown_pool_ids(client: TestClient):
    response = client.post(
        "/api/v1/users",
        json={
            "username": "pool-user",
            "display_name": "池授权用户",
            "password": "password123",
            "pool_ids": [999],
        },
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 422
    assert response.json()["details"]["pool_ids"] == [999]

def test_create_user_with_existing_team_ids(client: TestClient):
    team = client.post(
        "/api/v1/teams",
        json={"code": "t1", "name": "一组"},
        headers={"X-Dev-User": "admin"},
    )
    assert team.status_code == 201, team.text
    created = client.post(
        "/api/v1/users",
        json={
            "username": "dave",
            "display_name": "Dave",
            "password": "password123",
            "team_ids": [team.json()["id"]],
        },
        headers={"X-Dev-User": "admin"},
    )
    assert created.status_code == 201, created.text
    assert created.json()["team_ids"] == [team.json()["id"]]

def test_create_user_non_admin_forbidden(client: TestClient):
    response = client.post(
        "/api/v1/users",
        json={
            "username": "eve",
            "display_name": "Eve",
            "password": "password123",
        },
        headers={"X-Dev-User": "operator"},
    )
    assert response.status_code == 403

def test_update_user_not_found(client: TestClient):
    response = client.patch(
        "/api/v1/users/999",
        json={"display_name": "无人"},
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 422
    assert response.json()["message"] == "用户不存在"

def test_update_user_invalid_role(client: TestClient):
    created = _create_user(client)
    response = client.patch(
        f"/api/v1/users/{created['id']}",
        json={"role": "KING"},
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 422
    assert response.json()["message"] == "无效角色"

def test_update_user_invalid_owner_scope_rejected(client: TestClient):
    created = _create_user(client)
    response = client.patch(
        f"/api/v1/users/{created['id']}",
        json={"owner_scope": "PUBLIC"},
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 422
    assert response.json()["message"] == "无效数据范围"

def test_update_user_explicit_blank_display_name_rejected(client: TestClient):
    created = _create_user(client)
    response = client.patch(
        f"/api/v1/users/{created['id']}",
        json={"display_name": "   "},
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 422
    assert response.json()["message"] == "显示名称不能为空"

def test_update_user_success(client: TestClient):
    created = _create_user(client)
    response = client.patch(
        f"/api/v1/users/{created['id']}",
        json={"display_name": "Alice Wang", "phone": "13800000000", "is_active": True},
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["display_name"] == "Alice Wang"
    assert body["phone"] == "13800000000"

def test_user_phone_is_unique_and_creation_records_hired_on(client: TestClient):
    payload = {
        "username": "phone-owner",
        "display_name": "手机号用户",
        "password": "password123",
        "role": "OPERATOR",
        "phone": "13800001111",
    }
    created = client.post("/api/v1/users", json=payload, headers={"X-Dev-User": "admin"})
    assert created.status_code == 201, created.text
    assert created.json()["hired_on"] == date.today().isoformat()

    duplicate = client.post(
        "/api/v1/users",
        json={**payload, "username": "phone-owner-2", "display_name": "重复手机号"},
        headers={"X-Dev-User": "admin"},
    )
    assert duplicate.status_code == 409, duplicate.text
    assert "手机号已存在" in duplicate.json()["message"]

def test_user_phone_is_normalized_and_format_validated(client: TestClient):
    """设置-用户写入的手机号必须与免密登录读侧同一口径（归一化 + 11 位校验）。

    回归背景：手机号是手机号验证码 / 微信扫码登录的准入依据。写入侧若只 trim
    不校验，「+86 138-0000-0000」这类从通讯录复制的号码会原样落库，登录侧
    归一化后匹配不上，表现为「后台明明配了手机号，登录却说未开通」；而随便
    填的脏值（如 8 位）则永远不会生效，且没有任何报错。
    """
    created = client.post(
        "/api/v1/users",
        json={
            "username": "phone-norm",
            "display_name": "通讯录复制",
            "password": "password123",
            "role": "OPERATOR",
            "phone": "+86 139-0000-2222",
        },
        headers={"X-Dev-User": "admin"},
    )
    assert created.status_code == 201, created.text
    assert created.json()["phone"] == "13900002222"

    bad = client.patch(
        f"/api/v1/users/{created.json()['id']}",
        json={"phone": "1390000"},
        headers={"X-Dev-User": "admin"},
    )
    assert bad.status_code == 422, bad.text
    assert "手机号" in bad.json()["message"]

    cleared = client.patch(
        f"/api/v1/users/{created.json()['id']}",
        json={"phone": "  "},
        headers={"X-Dev-User": "admin"},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["phone"] is None

def test_user_service_rejects_unknown_and_immutable_fields(seeded_db):
    user = seeded_db.get(User, 1)
    assert user is not None
    with pytest.raises(Validation):
        service.update_user(
            seeded_db, user.id, changes={"unknown_field": "ignored"}, actor="pytest"
        )
    with pytest.raises(Validation):
        service.update_user(
            seeded_db, user.id, changes={"username": "changed"}, actor="pytest"
        )

def test_user_service_rejects_unhashable_role_and_scope(seeded_db):
    with pytest.raises(Validation, match="无效角色"):
        service.create_user(
            seeded_db,
            username="list-role",
            display_name="列表角色",
            password="password123",
            role=[],
            owner_scope="SELF",
            pool_ids=[],
            team_ids=[],
            phone=None,
            note=None,
            actor="pytest",
        )

    with pytest.raises(Validation, match="无效数据范围"):
        service.create_user(
            seeded_db,
            username="list-scope",
            display_name="列表范围",
            password="password123",
            role="VIEWER",
            owner_scope=[],
            pool_ids=[],
            team_ids=[],
            phone=None,
            note=None,
            actor="pytest",
        )

    user = seeded_db.get(User, 1)
    assert user is not None
    with pytest.raises(Validation, match="无效角色"):
        service.update_user(
            seeded_db, user.id, changes={"role": []}, actor="pytest"
        )
    with pytest.raises(Validation, match="无效数据范围"):
        service.update_user(
            seeded_db, user.id, changes={"owner_scope": []}, actor="pytest"
        )

def test_user_service_rejects_non_boolean_active_state(seeded_db):
    user = seeded_db.get(User, 1)
    assert user is not None

    with pytest.raises(Validation, match="启用状态必须为布尔值"):
        service.update_user(
            seeded_db, user.id, changes={"is_active": "false"}, actor="pytest"
        )

    seeded_db.commit()
    seeded_db.refresh(user)
    assert user.is_active is True

def test_user_deactivation_with_active_orders_requires_handover_or_retention_note(seeded_db):
    from app.orders.create import create_order

    order = create_order(
        seeded_db, order_type="HS", trade_date=date.today(),
        owner_id=1, actor="pytest",
    )

    with pytest.raises(Validation, match="转交或明确保留") as exc:
        service.update_user(
            seeded_db, 1, changes={"is_active": False}, actor="pytest"
        )

    assert exc.value.details["active_order_count"] == 1
    seeded_db.refresh(seeded_db.get(User, 1))
    assert seeded_db.get(User, 1).is_active is True
    assert seeded_db.get(Order, order.id).owner_id == 1

def test_user_deactivation_handover_moves_active_orders_and_records_audit(seeded_db):
    from app.orders.create import create_order

    order = create_order(
        seeded_db, order_type="HS", trade_date=date.today(), owner_id=1, actor="pytest",
    )
    updated = service.update_user(
        seeded_db,
        1,
        changes={"is_active": False, "handover_user_id": 2},
        actor="admin",
    )

    assert updated.is_active is False
    assert updated.handover_user_id == 2
    assert updated.deactivated_on == date.today()
    assert seeded_db.get(Order, order.id).owner_id == 2
    actions = {
        row.action for row in seeded_db.scalars(select(AuditLog)).all()
    }
    assert AuditAction.USER_DEACTIVATE.value in actions
    assert AuditAction.USER_HANDOVER.value in actions

def test_user_deactivation_rejects_inactive_handover_target(seeded_db):
    from app.orders.create import create_order

    target = seeded_db.get(User, 2)
    target.is_active = False
    seeded_db.flush()
    create_order(
        seeded_db, order_type="HS", trade_date=date.today(), owner_id=1, actor="pytest",
    )

    with pytest.raises(Validation, match="交接目标必须是启用用户"):
        service.update_user(
            seeded_db,
            1,
            changes={"is_active": False, "handover_user_id": 2},
            actor="admin",
        )

def test_user_service_validates_password_and_scope_id_shapes(seeded_db):
    with pytest.raises(Validation, match="密码至少需要 8 位"):
        service.create_user(
            seeded_db,
            username="short-password",
            display_name="短密码",
            password="short",
            role="VIEWER",
            owner_scope="SELF",
            pool_ids=[],
            team_ids=[],
            phone=None,
            note=None,
            actor="pytest",
        )

    with pytest.raises(Validation, match="资金账户 ID 必须为正整数"):
        service.create_user(
            seeded_db,
            username="bad-pool-id",
            display_name="坏池编号",
            password="password123",
            role="VIEWER",
            owner_scope="SELF",
            pool_ids=[True],
            team_ids=[],
            phone=None,
            note=None,
            actor="pytest",
        )
