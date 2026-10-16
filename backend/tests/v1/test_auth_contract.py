"""auth 路由契约测试：登录 / 改密 / 登出 / 用户管理 / 团队管理。

覆盖策略：
- 登录链路用「POST /users 建号 → POST /auth/login 换 token → Bearer 调后续端点」全链路；
- 权限分支用 `X-Dev-User` 切换 dev 身份（admin 恒过、viewer 必 403）；
- 数据隔离沿用 tests/v1/conftest.py 的「跑完清库」策略，不跨用例泄漏。
"""
from __future__ import annotations

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.domain.enums import AuditAction
from app.domain.foundation import AuditLog
from app.core.security import hash_password
from app.domain.users import RevokedToken, User
from app.core.settings import Settings
from app.core.security import CurrentUser, build_access_token, get_current_user, AuthError


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


def test_user_security_scope_values_are_constrained_in_database(seeded_db):
    seeded_db.add(
        User(
            username="invalid-role",
            display_name="无效角色",
            password_hash="hash",
            role="ROOT",
            owner_scope="SELF",
        )
    )
    with pytest.raises(IntegrityError):
        seeded_db.flush()
    seeded_db.rollback()

    seeded_db.add(RevokedToken(jti="invalid-expiry", expires_at=0))
    with pytest.raises(IntegrityError):
        seeded_db.flush()
    seeded_db.rollback()

    seeded_db.add(
        User(
            username="invalid-scope",
            display_name="无效范围",
            password_hash="hash",
            role="VIEWER",
            owner_scope="PUBLIC",
        )
    )
    with pytest.raises(IntegrityError):
        seeded_db.flush()
    seeded_db.rollback()


# ------------------------------------------------------------------ 登录 / 登出


def test_login_success_returns_token_and_public_user(client: TestClient):
    _create_user(client)
    response = client.post(
        "/api/v1/auth/login", json={"username": "alice", "password": "password123"}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["access_token"]
    assert body["user"]["username"] == "alice"
    assert body["user"]["must_change_password"] is True
    assert body["user"]["created_at"]


def test_login_rejects_wrong_password(client: TestClient):
    _create_user(client)
    response = client.post(
        "/api/v1/auth/login", json={"username": "alice", "password": "wrong-pass"}
    )
    assert response.status_code == 401
    assert response.json()["code"] == "AUTH_REQUIRED"


def test_login_rejects_unknown_user(client: TestClient):
    response = client.post(
        "/api/v1/auth/login", json={"username": "ghost", "password": "password123"}
    )
    assert response.status_code == 401


def test_login_rejects_inactive_user(client: TestClient):
    created = _create_user(client)
    patch = client.patch(
        f"/api/v1/users/{created['id']}",
        json={"is_active": False},
        headers={"X-Dev-User": "admin"},
    )
    assert patch.status_code == 200, patch.text
    response = client.post(
        "/api/v1/auth/login", json={"username": "alice", "password": "password123"}
    )
    assert response.status_code == 401


def test_me_with_db_record_via_bearer_token(client: TestClient):
    token = _login(client, "alice", "password123") if _create_user(client) else ""
    response = client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["username"] == "alice"
    assert response.json()["pool_ids"] == []


def test_me_falls_back_to_token_payload_without_db_record(client: TestClient):
    # dev 直通身份在 users 表无对应行 → 走 token 兜底分支
    response = client.get("/api/v1/auth/me", headers={"X-Dev-User": "admin"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["username"] == "admin"
    assert body["role"] == "ADMIN"
    assert body["is_active"] is True


def test_production_bearer_token_requires_database_user(db: Session):
    settings = Settings(
        app_env="production",
        jwt_secret_key="test-production-secret-0123456789-abcdef",
    )
    token = build_access_token(
        CurrentUser.build(id=9999, username="deleted-user", roles=["ADMIN"], owner_scope="ALL"),
        settings=settings,
    )
    with pytest.raises(AuthError) as exc:
        get_current_user(
            authorization=f"Bearer {token}",
            x_dev_user=None,
            settings=settings,
            db=db,
        )
    assert "账号" in str(exc.value)


def test_me_requires_authentication(client: TestClient):
    assert client.get("/api/v1/auth/me").status_code == 401


def test_change_password_wrong_old_password(client: TestClient):
    _create_user(client)
    token = _login(client, "alice", "password123")
    response = client.post(
        "/api/v1/auth/change-password",
        json={"old_password": "not-the-one", "new_password": "newpassword1"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401


def test_change_password_success_then_login_with_new_password(client: TestClient):
    _create_user(client)
    token = _login(client, "alice", "password123")
    response = client.post(
        "/api/v1/auth/change-password",
        json={"old_password": "password123", "new_password": "newpassword1"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    # 新密码可登录，旧密码失效
    assert _login(client, "alice", "newpassword1")
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"username": "alice", "password": "password123"},
        ).status_code
        == 401
    )


def test_logout_without_authorization_header(client: TestClient):
    response = client.post("/api/v1/auth/logout")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_logout_ignores_non_bearer_scheme(client: TestClient):
    response = client.post(
        "/api/v1/auth/logout", headers={"Authorization": "Basic abc123"}
    )
    assert response.status_code == 200


def test_logout_revokes_token(client: TestClient, db: Session):
    _create_user(client)
    token = _login(client, "alice", "password123")
    response = client.post(
        "/api/v1/auth/logout", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200
    # 生产 get_db 在请求边界统一 commit；测试夹具为隔离不提交，
    # 这里显式 flush 模拟「撤销行已落库」后再重放 token。
    db.flush()
    # 被撤销的 token 再次访问 /me 必须 401
    replay = client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert replay.status_code == 401
    assert replay.json()["code"] == "AUTH_REQUIRED"


# ------------------------------------------------------------------ 用户管理


def test_list_users_admin_ok_viewer_forbidden(client: TestClient):
    _create_user(client)
    admin_resp = client.get("/api/v1/users", headers={"X-Dev-User": "admin"})
    assert admin_resp.status_code == 200, admin_resp.text
    assert [item["username"] for item in admin_resp.json()] == ["alice"]

    forbidden = client.get("/api/v1/users", headers={"X-Dev-User": "viewer"})
    assert forbidden.status_code == 403
    assert forbidden.json()["code"] == "PERMISSION_DENIED"


def test_create_user_invalid_role(client: TestClient):
    response = client.post(
        "/api/v1/users",
        json={
            "username": "bob",
            "display_name": "Bob",
            "password": "password123",
            "role": "SUPERUSER",
        },
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 422
    assert response.json()["message"] == "无效角色"


def test_create_user_invalid_owner_scope_rejected(client: TestClient):
    response = client.post(
        "/api/v1/users",
        json={
            "username": "scope-user",
            "display_name": "范围用户",
            "password": "password123",
            "owner_scope": "PUBLIC",
        },
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 422
    assert response.json()["message"] == "无效数据范围"


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


# ------------------------------------------------------------------ 团队管理


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
