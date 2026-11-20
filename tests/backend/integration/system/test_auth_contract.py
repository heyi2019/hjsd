"""AUTH-01 auth 路由契约测试：登录 / 改密 / 登出 / 用户管理 / 团队管理。

覆盖策略：
- 登录链路用「POST /users 建号 → POST /auth/login 换 token → Bearer 调后续端点」全链路；
- 权限分支用 `X-Dev-User` 切换 dev 身份（admin 恒过、viewer 必 403）；
- 数据隔离沿用 tests/backend/conftest.py 的「跑完清库」策略，不跨用例泄漏。
"""
from __future__ import annotations

from fastapi.testclient import TestClient
import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app.core.security import CurrentUser, build_access_token, AuthError
from app.settings.auth.session import get_current_user
from app.core.settings import Settings
from app.domain.users import RevokedToken, User

def _create_user(client: TestClient, *, username: str = "alice", password: str = "password123",
                 role: str = "VIEWER") -> dict:
    response = client.post(
        "/api/users",
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
        "/api/auth/login",
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

def test_login_success_returns_token_and_public_user(client: TestClient):
    _create_user(client)
    response = client.post(
        "/api/auth/login", json={"username": "alice", "password": "password123"}
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
        "/api/auth/login", json={"username": "alice", "password": "wrong-pass"}
    )
    assert response.status_code == 401
    assert response.json()["code"] == "AUTH_REQUIRED"

def test_login_rejects_unknown_user(client: TestClient):
    response = client.post(
        "/api/auth/login", json={"username": "ghost", "password": "password123"}
    )
    assert response.status_code == 401

def test_login_rejects_inactive_user(client: TestClient):
    created = _create_user(client)
    patch = client.patch(
        f"/api/users/{created['id']}",
        json={"is_active": False},
        headers={"X-Dev-User": "admin"},
    )
    assert patch.status_code == 200, patch.text
    response = client.post(
        "/api/auth/login", json={"username": "alice", "password": "password123"}
    )
    assert response.status_code == 401

def test_me_with_db_record_via_bearer_token(client: TestClient):
    token = _login(client, "alice", "password123") if _create_user(client) else ""
    response = client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["username"] == "alice"
    assert response.json()["pool_ids"] == []

def test_me_falls_back_to_token_payload_without_db_record(client: TestClient):
    # dev 直通身份在 users 表无对应行 → 走 token 兜底分支
    response = client.get("/api/auth/me", headers={"X-Dev-User": "admin"})
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

def test_malformed_bearer_identity_claim_is_auth_error(client: TestClient):
    from app.core.security import encode_token

    token = encode_token({"sub": "not-an-id", "username": "broken", "roles": []})
    response = client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 401
    assert response.json()["message"] == "登录凭证内容无效"

def test_malformed_bearer_jti_claim_is_auth_error(client: TestClient):
    from app.core.security import encode_token

    token = encode_token(
        {"sub": "1", "username": "admin", "roles": ["ADMIN"], "jti": {"bad": True}}
    )
    response = client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 401
    assert response.json()["message"] == "登录凭证内容无效"

def test_me_requires_authentication(client: TestClient):
    assert client.get("/api/auth/me").status_code == 401

def test_change_password_wrong_old_password(client: TestClient):
    _create_user(client)
    token = _login(client, "alice", "password123")
    response = client.post(
        "/api/auth/change-password",
        json={"old_password": "not-the-one", "new_password": "newpassword1"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401

def test_change_password_success_then_login_with_new_password(client: TestClient):
    _create_user(client)
    token = _login(client, "alice", "password123")
    response = client.post(
        "/api/auth/change-password",
        json={"old_password": "password123", "new_password": "newpassword1"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    # 新密码可登录，旧密码失效
    assert _login(client, "alice", "newpassword1")
    assert (
        client.post(
            "/api/auth/login",
            json={"username": "alice", "password": "password123"},
        ).status_code
        == 401
    )

def test_logout_without_authorization_header(client: TestClient):
    response = client.post("/api/auth/logout")
    assert response.status_code == 200
    assert response.json()["ok"] is True

def test_logout_ignores_non_bearer_scheme(client: TestClient):
    response = client.post(
        "/api/auth/logout", headers={"Authorization": "Basic abc123"}
    )
    assert response.status_code == 200

def test_logout_revokes_token(client: TestClient, db: Session):
    _create_user(client)
    token = _login(client, "alice", "password123")
    response = client.post(
        "/api/auth/logout", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200
    # 生产 get_db 在请求边界统一 commit；测试夹具为隔离不提交，
    # 这里显式 flush 模拟「撤销行已落库」后再重放 token。
    db.flush()
    # 被撤销的 token 再次访问 /me 必须 401
    replay = client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert replay.status_code == 401
    assert replay.json()["code"] == "AUTH_REQUIRED"

def test_logout_rejects_malformed_jti_claim(client: TestClient):
    from app.core.security import encode_token

    token = encode_token(
        {"sub": "1", "username": "admin", "roles": ["ADMIN"], "jti": {"bad": True}}
    )
    response = client.post(
        "/api/auth/logout", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 401
    assert response.json()["message"] == "登录凭证内容无效"

def test_list_users_admin_ok_viewer_forbidden(client: TestClient):
    _create_user(client)
    admin_resp = client.get("/api/users", headers={"X-Dev-User": "admin"})
    assert admin_resp.status_code == 200, admin_resp.text
    assert [item["username"] for item in admin_resp.json()] == ["alice"]

    forbidden = client.get("/api/users", headers={"X-Dev-User": "viewer"})
    assert forbidden.status_code == 403
    assert forbidden.json()["code"] == "PERMISSION_DENIED"

def test_create_user_invalid_role(client: TestClient):
    response = client.post(
        "/api/users",
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
        "/api/users",
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
