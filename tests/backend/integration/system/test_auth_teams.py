"""AUTH-01 auth 路由契约测试：登录 / 改密 / 登出 / 用户管理 / 团队管理。

覆盖策略：
- 登录链路用「POST /users 建号 → POST /auth/login 换 token → Bearer 调后续端点」全链路；
- 权限分支用 `X-Dev-User` 切换 dev 身份（admin 恒过、viewer 必 403）；
- 数据隔离沿用 tests/backend/conftest.py 的「跑完清库」策略，不跨用例泄漏。
"""
from __future__ import annotations

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.auth import service
from app.core.errors import Validation
from app.core.security import hash_password
from app.core.security import CurrentUser
from app.core.settings import Settings
from app.domain.enums import AuditAction
from app.domain.foundation import AuditLog
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

def test_reset_password_not_found(client: TestClient):
    response = client.post(
        "/api/v1/users/999/reset-password",
        json={"password": "resetpass1"},
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 422
    assert response.json()["message"] == "用户不存在"

def test_reset_password_success(client: TestClient):
    created = _create_user(client)
    response = client.post(
        f"/api/v1/users/{created['id']}/reset-password",
        json={"password": "resetpass1"},
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    # 重置后的密码可登录，且 must_change_password 重新置位
    token = _login(client, "alice", "resetpass1")
    me = client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert me.json()["must_change_password"] is True

def test_list_teams(client: TestClient):
    response = client.get("/api/v1/teams", headers={"X-Dev-User": "viewer"})
    assert response.status_code == 200
    assert response.json() == []

def test_create_team_success_normalizes_code(client: TestClient):
    response = client.post(
        "/api/v1/teams",
        json={"code": " t1 ", "name": " 一组 ", "description": " desc "},
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["code"] == "T1"
    assert body["name"] == "一组"
    assert body["is_active"] is True

def test_create_team_duplicate_code(client: TestClient):
    headers = {"X-Dev-User": "admin"}
    assert client.post("/api/v1/teams", json={"code": "T1", "name": "一组"}, headers=headers).status_code == 201
    # 大小写归一化后仍判重
    response = client.post("/api/v1/teams", json={"code": "t1", "name": "重名"}, headers=headers)
    assert response.status_code == 409
    assert response.json()["message"] == "团队编码已存在"

def test_create_team_blank_name_rejected(client: TestClient):
    response = client.post(
        "/api/v1/teams",
        json={"code": "blank-name", "name": "   "},
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 422
    assert response.json()["message"] == "团队名称不能为空"

def test_create_team_non_admin_forbidden(client: TestClient):
    response = client.post(
        "/api/v1/teams",
        json={"code": "t9", "name": "九组"},
        headers={"X-Dev-User": "viewer"},
    )
    assert response.status_code == 403

def test_update_team_not_found(client: TestClient):
    response = client.patch(
        "/api/v1/teams/999",
        json={"name": "无人"},
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 422
    assert response.json()["message"] == "团队不存在"

def test_update_team_success(client: TestClient):
    created = client.post(
        "/api/v1/teams",
        json={"code": "t2", "name": "二组"},
        headers={"X-Dev-User": "admin"},
    )
    assert created.status_code == 201
    response = client.patch(
        f"/api/v1/teams/{created.json()['id']}",
        json={"name": "二组改名", "is_active": False},
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "二组改名"
    assert body["is_active"] is False

def test_update_team_explicit_blank_name_rejected(client: TestClient):
    created = client.post(
        "/api/v1/teams",
        json={"code": "t3", "name": "三组"},
        headers={"X-Dev-User": "admin"},
    )
    assert created.status_code == 201
    response = client.patch(
        f"/api/v1/teams/{created.json()['id']}",
        json={"name": "   "},
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 422
    assert response.json()["message"] == "团队名称不能为空"

def test_team_service_rejects_unknown_fields(seeded_db):
    team = service.create_team(
        seeded_db, code="T-SERVICE", name="服务团队", description=None, actor="pytest"
    )
    with pytest.raises(Validation):
        service.update_team(
            seeded_db, team.id, changes={"unknown_field": "ignored"}, actor="pytest"
        )

def test_team_service_rejects_non_boolean_active_state(seeded_db):
    team = service.create_team(
        seeded_db, code="T-SERVICE-BOOL", name="服务团队", description=None, actor="pytest"
    )

    with pytest.raises(Validation, match="启用状态必须为布尔值"):
        service.update_team(
            seeded_db, team.id, changes={"is_active": "false"}, actor="pytest"
        )

    seeded_db.commit()
    seeded_db.refresh(team)
    assert team.is_active is True

def test_admin_mutations_write_audit(client: TestClient, db: Session):
    created = _create_user(client)
    updated = client.patch(
        f"/api/v1/users/{created['id']}",
        json={"display_name": "Alice Wang"},
        headers={"X-Dev-User": "admin"},
    )
    assert updated.status_code == 200, updated.text
    reset = client.post(
        f"/api/v1/users/{created['id']}/reset-password",
        json={"password": "resetpass1"},
        headers={"X-Dev-User": "admin"},
    )
    assert reset.status_code == 200, reset.text
    team = client.post(
        "/api/v1/teams",
        json={"code": "t1", "name": "一组"},
        headers={"X-Dev-User": "admin"},
    )
    assert team.status_code == 201, team.text
    team_update = client.patch(
        f"/api/v1/teams/{team.json()['id']}",
        json={"name": "一组改名"},
        headers={"X-Dev-User": "admin"},
    )
    assert team_update.status_code == 200, team_update.text

    actions = {
        row.action
        for row in db.scalars(select(AuditLog).order_by(AuditLog.id)).all()
    }
    assert {
        AuditAction.USER_CREATE.value,
        AuditAction.USER_UPDATE.value,
        AuditAction.PASSWORD_RESET.value,
        AuditAction.TEAM_CREATE.value,
        AuditAction.TEAM_UPDATE.value,
    } <= actions

def test_update_user_unknown_team_ids_rejected(client: TestClient, db: Session):
    # update 路径同样校验 team_ids（不存在即 422）
    created = _create_user(client)
    response = client.patch(
        f"/api/v1/users/{created['id']}",
        json={"team_ids": [777]},
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 422
    assert response.json()["details"]["team_ids"] == [777]

def test_login_user_created_directly_in_db(client: TestClient, db: Session):
    # 直接落库的用户同样可登录（覆盖 login 对 DB 行的读取路径）
    db.add(
        User(
            username="frank",
            display_name="Frank",
            password_hash=hash_password("password123"),
        )
    )
    db.flush()
    response = client.post(
        "/api/v1/auth/login", json={"username": " frank ", "password": "password123"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["user"]["username"] == "frank"

def test_bearer_permissions_refresh_after_user_role_change(
    seeded_client: TestClient,
):
    created = _create_user(seeded_client, username="live-role", role="VIEWER")
    token = _login(seeded_client, "live-role", "password123")

    updated = seeded_client.patch(
        f"/api/v1/users/{created['id']}",
        json={"role": "OPERATOR"},
        headers={"X-Dev-User": "admin"},
    )
    assert updated.status_code == 200, updated.text

    response = seeded_client.post(
        "/api/v1/customers",
        json={"display_name": "权限即时生效"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 201, response.text

def test_bearer_permissions_refresh_after_user_deactivation(client: TestClient):
    created = _create_user(client, username="live-active", role="OPERATOR")
    token = _login(client, "live-active", "password123")

    updated = client.patch(
        f"/api/v1/users/{created['id']}",
        json={"is_active": False},
        headers={"X-Dev-User": "admin"},
    )
    assert updated.status_code == 200, updated.text

    response = client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401

def test_current_user_owner_scope_model():
    """CurrentUser 的数据范围模型是权限隔离的底座，单独钉住。

    - 管理员 / ALL 范围可见任意资金账户；
    - TEAM 范围按 pool_ids 判定可见性；
    - SELF 范围（pool_ids 为空）看不到任何具体池。
    """
    admin = CurrentUser.build(id=1, username="admin", roles=["ADMIN"], owner_scope="ALL")
    assert admin.is_admin is True
    assert admin.can_see_pool(999) is True

    scoped = CurrentUser.build(
        id=2, username="op", roles=["OPERATOR"], owner_scope="TEAM",
        pool_ids=frozenset({1, 2}), team_ids=frozenset({1}),
    )
    assert scoped.is_admin is False
    assert scoped.can_see_pool(1) is True
    assert scoped.can_see_pool(2) is True
    assert scoped.can_see_pool(3) is False

    self_only = CurrentUser.build(
        id=3, username="self", roles=["VIEWER"], owner_scope="SELF",
    )
    # SELF 无任何池授权（pool_ids 为空）→ 看不到任何具体池
    assert self_only.can_see_pool(1) is False

@pytest.mark.parametrize("raw", ["PRODUCTION", " production "])
def test_is_production_normalizes_case_and_space(raw):
    assert Settings(app_env=raw).is_production is True

@pytest.mark.parametrize("raw", ["development", "staging"])
def test_is_production_false_for_non_prod(raw):
    assert Settings(app_env=raw).is_production is False
