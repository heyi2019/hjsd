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
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app.core.security import CurrentUser, build_access_token, AuthError
from app.settings.auth.session import get_current_user
from app.core.settings import Settings
from app.domain.trade import Account
from app.domain.users import RevokedToken, User
from app.business.inventory._common import scope_filter
from app.shared.user_identity import actor_names, user_id_for_actor

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


def test_employee_code_is_sequential_and_independent_of_login_name(client: TestClient):
    first = _create_user(client, username="alice")
    second = _create_user(client, username="bob")
    assert first["employee_code"] == f"yy{first['id']:03d}"
    assert second["employee_code"] == f"yy{second['id']:03d}"
    assert second["id"] == first["id"] + 1
    token = _login(client, "alice", "password123")
    changed_password = client.post(
        "/api/auth/change-password", headers={"Authorization": f"Bearer {token}"},
        json={"old_password": "password123", "new_password": "newpassword1"},
    )
    assert changed_password.status_code == 200
    token = changed_password.json()["access_token"]
    renamed = client.post(
        "/api/auth/change-username", headers={"Authorization": f"Bearer {token}"},
        json={"username": "alice-new", "current_password": "newpassword1"},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["user"]["employee_code"] == first["employee_code"]
    assert _login(client, "alice-new", "newpassword1")


def test_team_code_is_automatically_assigned_and_stable(client: TestClient):
    headers = {"X-Dev-User": "admin"}
    first = client.post("/api/teams", json={"name": "一组"}, headers=headers)
    second = client.post("/api/teams", json={"name": "二组"}, headers=headers)
    assert first.status_code == second.status_code == 201
    assert [first.json()["code"], second.json()["code"]] == ["team_01", "team_02"]
    renamed = client.patch(f"/api/teams/{first.json()['id']}", json={"name": "新一组"}, headers=headers)
    assert renamed.status_code == 200
    assert renamed.json()["code"] == "team_01"

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
            request=None,
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


def test_change_username_preserves_account_identity_and_history(client: TestClient, seeded_db: Session):
    account = _create_user(client, role="OPERATOR")
    existing = _create_user(client, username="taken")
    token = _login(client, "alice", "password123")
    header = {"Authorization": f"Bearer {token}"}
    password = client.post("/api/auth/change-password", headers=header, json={
        "old_password": "password123", "new_password": "newpassword1",
    })
    header = {"Authorization": f"Bearer {password.json()['access_token']}"}

    assert client.post("/api/auth/change-username", headers=header, json={
        "username": "alice-new", "current_password": "wrong",
    }).status_code == 422
    assert client.post("/api/auth/change-username", headers=header, json={
        "username": existing["username"], "current_password": "newpassword1",
    }).status_code == 409
    changed = client.post("/api/auth/change-username", headers=header, json={
        "username": " alice-new ", "current_password": "newpassword1",
    })
    assert changed.status_code == 200, changed.text
    result = changed.json()
    assert result["user"]["id"] == account["id"]
    assert result["user"]["username"] == "alice-new"
    assert client.get("/api/auth/me", headers=header).status_code == 401
    assert client.get("/api/auth/me", headers={
        "Authorization": f"Bearer {result['access_token']}",
    }).json()["username"] == "alice-new"
    assert client.post("/api/auth/login", json={"username": "alice", "password": "newpassword1"}).status_code == 401
    assert _login(client, "alice-new", "newpassword1")
    assert client.post("/api/users", headers={"X-Dev-User": "admin"}, json={
        "username": "alice", "display_name": "其他用户", "password": "password123",
    }).status_code == 409

    assert user_id_for_actor(seeded_db, "alice") == account["id"]
    assert set(actor_names(seeded_db, ["alice-new"])) == {"alice", "alice-new"}
    stock = Account(game_account="legacy-inventory", created_by="alice")
    unowned = Account(game_account="other-inventory", created_by="taken")
    seeded_db.add_all([stock, unowned])
    seeded_db.flush()
    renamed = CurrentUser.build(id=account["id"], username="alice-new", roles=["OPERATOR"])
    visible = set(seeded_db.scalars(select(Account.id).where(scope_filter(seeded_db, renamed))))
    assert stock.id in visible and unowned.id not in visible
    assert stock.created_by == "alice"


def test_password_change_is_required_and_invalidates_old_sessions(client: TestClient):
    user = _create_user(client, role="OPERATOR")
    first = _login(client, "alice", "password123")
    other = _login(client, "alice", "password123")
    first_header = {"Authorization": f"Bearer {first}"}
    assert client.get("/api/auth/me", headers=first_header).status_code == 200
    blocked = client.get("/api/orders", headers=first_header)
    assert blocked.status_code == 403 and blocked.json()["code"] == "PASSWORD_CHANGE_REQUIRED"
    changed = client.post("/api/auth/change-password", headers=first_header, json={"old_password": "password123", "new_password": "newpassword1"})
    assert changed.status_code == 200, changed.text
    current = changed.json()["access_token"]
    assert client.get("/api/orders", headers={"Authorization": f"Bearer {current}"}).status_code == 200
    assert client.get("/api/auth/me", headers=first_header).status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {other}"}).status_code == 401
    reset = client.post(f"/api/users/{user['id']}/reset-password", headers={"X-Dev-User": "admin"}, json={"password": "resetpass1"})
    assert reset.status_code == 200
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {current}"}).status_code == 401
    reset_token = _login(client, "alice", "resetpass1")
    assert client.get("/api/orders", headers={"Authorization": f"Bearer {reset_token}"}).status_code == 403

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
