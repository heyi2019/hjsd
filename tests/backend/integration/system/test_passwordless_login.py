"""免密登录契约测试：手机号验证码登录 + 微信登录绑定。

覆盖的安全边界（这几条一旦回归就是「绕过密码」级别的漏洞）：
1. 手机号必须已在 users.phone 配置且在职业账号，否则一律拒绝；
2. 验证码票据绑定手机号，不能拿 A 的票据配 B 的号；
3. 微信未绑定时只能拿到 bind_ticket，拿不到 access_token；
4. 绑定后再次登录才免验证码；账号手机号变更后旧绑定自动作废；
5. 解绑后回到未绑定态。
"""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app.core.ratelimit import login_limiter
from app.core.settings import get_settings


@pytest.fixture(autouse=True)
def _reset_limiters():
    """限流器是进程内单例，用例之间必须清空，否则第 N 个用例会被前面的计数拦住。"""
    login_limiter.reset()
    yield
    login_limiter.reset()


@pytest.fixture()
def wechat_mock(monkeypatch: pytest.MonkeyPatch):
    """启用 mock 微信通道：授权地址自回跳，走与真实通道一样的两段式流程。"""
    monkeypatch.setenv("WECHAT_LOGIN_ENABLED", "true")
    monkeypatch.setenv("WECHAT_PROVIDER", "mock")
    monkeypatch.setenv("WECHAT_BIND_VERIFY_MODE", "sms")
    monkeypatch.setenv("SMS_PROVIDER", "mock")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _create_user(client: TestClient, *, username: str, phone: str, password: str = "password123") -> dict:
    response = client.post(
        "/api/v1/users",
        json={
            "username": username,
            "display_name": f"测试用户{username}",
            "password": password,
            "role": "OPERATOR",
            "phone": phone,
        },
        headers={"X-Dev-User": "admin"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _send_code(client: TestClient, phone: str) -> dict:
    response = client.post("/api/v1/auth/phone/code", json={"phone": phone})
    assert response.status_code == 200, response.text
    return response.json()


def test_login_methods_expose_only_ready_entries(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """未配置微信时不点亮入口。显式指定环境，避免依赖开发者本机 .env。"""
    monkeypatch.setenv("WECHAT_LOGIN_ENABLED", "false")
    monkeypatch.setenv("WECHAT_PROVIDER", "disabled")
    get_settings.cache_clear()
    data = client.get("/api/v1/auth/login-methods").json()
    assert data["password"]["enabled"] is True
    assert data["phone_code"]["enabled"] is True
    assert data["wechat"]["enabled"] is False
    assert data["wechat"]["provider"] == "disabled"


def test_phone_code_login_full_flow(client: TestClient) -> None:
    _create_user(client, username="phoneuser", phone="13800000001")

    sent = _send_code(client, "13800000001")
    assert sent["sent"] is True
    # 开发环境走 mock 通道，验证码回显给调用方（生产环境恒为 null）。
    assert sent["dev_code"] and len(sent["dev_code"]) == 6

    response = client.post(
        "/api/v1/auth/phone/login",
        json={"phone": "13800000001", "code": sent["dev_code"], "code_ticket": sent["code_ticket"]},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "logged_in"
    assert payload["user"]["username"] == "phoneuser"

    me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {payload['access_token']}"})
    assert me.status_code == 200
    assert me.json()["username"] == "phoneuser"


def test_phone_code_normalizes_common_formats(client: TestClient) -> None:
    """通讯录复制的 `+86 138-0000-0002` 必须能登录，否则会被当成「未配置」。"""
    _create_user(client, username="phoneuser2", phone="13800000002")
    sent = _send_code(client, "+86 138-0000-0002")
    response = client.post(
        "/api/v1/auth/phone/login",
        json={"phone": "138 0000 0002", "code": sent["dev_code"], "code_ticket": sent["code_ticket"]},
    )
    assert response.status_code == 200, response.text


def test_phone_code_rejects_unconfigured_phone(client: TestClient) -> None:
    response = client.post("/api/v1/auth/phone/code", json={"phone": "13900000099"})
    assert response.status_code == 401, response.text
    assert "未开通" in response.text


def test_phone_login_rejects_wrong_code(client: TestClient) -> None:
    _create_user(client, username="phoneuser3", phone="13800000003")
    sent = _send_code(client, "13800000003")
    wrong = "000000" if sent["dev_code"] != "000000" else "111111"
    response = client.post(
        "/api/v1/auth/phone/login",
        json={"phone": "13800000003", "code": wrong, "code_ticket": sent["code_ticket"]},
    )
    assert response.status_code == 422, response.text


def test_phone_login_ticket_is_bound_to_phone(client: TestClient) -> None:
    """A 号的验证码票据不能配 B 号使用。"""
    _create_user(client, username="phoneuser4", phone="13800000004")
    _create_user(client, username="phoneuser5", phone="13800000005")
    sent = _send_code(client, "13800000004")
    response = client.post(
        "/api/v1/auth/phone/login",
        json={"phone": "13800000005", "code": sent["dev_code"], "code_ticket": sent["code_ticket"]},
    )
    assert response.status_code == 422, response.text


def _authorize(client: TestClient) -> tuple[str, str]:
    response = client.get("/api/v1/auth/wechat/authorize", params={"redirect_uri": "http://testserver/"})
    assert response.status_code == 200, response.text
    data = response.json()
    query = parse_qs(urlparse(data["authorize_url"]).query)
    return query["code"][0], data["state"]


def test_wechat_login_requires_binding_first(client: TestClient, wechat_mock) -> None:
    _create_user(client, username="wxuser", phone="13800000011")
    code, state = _authorize(client)

    response = client.post("/api/v1/auth/wechat/login", json={"code": code, "state": state})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "bind_required"
    # 未绑定绝不能拿到 token。
    assert payload["access_token"] is None
    assert payload["bind_ticket"]


def test_wechat_bind_then_login_without_code(client: TestClient, wechat_mock) -> None:
    _create_user(client, username="wxuser2", phone="13800000012")
    code, state = _authorize(client)
    bind_ticket = client.post(
        "/api/v1/auth/wechat/login", json={"code": code, "state": state}
    ).json()["bind_ticket"]

    sent = client.post(
        "/api/v1/auth/wechat/bind/code", json={"bind_ticket": bind_ticket, "phone": "13800000012"}
    ).json()
    assert sent["dev_code"]

    confirmed = client.post(
        "/api/v1/auth/wechat/bind/confirm",
        json={
            "bind_ticket": bind_ticket,
            "phone": "13800000012",
            "code_ticket": sent["code_ticket"],
            "code": sent["dev_code"],
        },
    )
    assert confirmed.status_code == 200, confirmed.text
    body = confirmed.json()
    assert body["status"] == "logged_in"
    assert body["user"]["username"] == "wxuser2"

    # 同一微信再次登录：直接返回 token，无需验证码（mock code 相同则 open_id 相同）。
    again = client.post("/api/v1/auth/wechat/login", json={"code": code, "state": state})
    assert again.json()["status"] == "logged_in"
    assert again.json()["access_token"]


def test_wechat_bind_rejects_unconfigured_phone(client: TestClient, wechat_mock) -> None:
    code, state = _authorize(client)
    bind_ticket = client.post(
        "/api/v1/auth/wechat/login", json={"code": code, "state": state}
    ).json()["bind_ticket"]
    response = client.post(
        "/api/v1/auth/wechat/bind/code", json={"bind_ticket": bind_ticket, "phone": "13900000098"}
    )
    assert response.status_code == 401, response.text


def test_wechat_binding_invalidated_after_phone_change(client: TestClient, wechat_mock) -> None:
    created = _create_user(client, username="wxuser3", phone="13800000013")
    code, state = _authorize(client)
    bind_ticket = client.post(
        "/api/v1/auth/wechat/login", json={"code": code, "state": state}
    ).json()["bind_ticket"]
    sent = client.post(
        "/api/v1/auth/wechat/bind/code", json={"bind_ticket": bind_ticket, "phone": "13800000013"}
    ).json()
    client.post(
        "/api/v1/auth/wechat/bind/confirm",
        json={
            "bind_ticket": bind_ticket,
            "phone": "13800000013",
            "code_ticket": sent["code_ticket"],
            "code": sent["dev_code"],
        },
    )

    # 管理员把手机号改掉 → 旧微信不再代表该账号。
    updated = client.patch(
        f"/api/v1/users/{created['id']}",
        json={"phone": "13800000014"},
        headers={"X-Dev-User": "admin"},
    )
    assert updated.status_code == 200, updated.text

    again = client.post("/api/v1/auth/wechat/login", json={"code": code, "state": state})
    assert again.json()["status"] == "bind_required"


def test_wechat_unbind_returns_to_bind_required(client: TestClient, wechat_mock) -> None:
    _create_user(client, username="wxuser4", phone="13800000015")
    code, state = _authorize(client)
    bind_ticket = client.post(
        "/api/v1/auth/wechat/login", json={"code": code, "state": state}
    ).json()["bind_ticket"]
    sent = client.post(
        "/api/v1/auth/wechat/bind/code", json={"bind_ticket": bind_ticket, "phone": "13800000015"}
    ).json()
    logged_in = client.post(
        "/api/v1/auth/wechat/bind/confirm",
        json={
            "bind_ticket": bind_ticket,
            "phone": "13800000015",
            "code_ticket": sent["code_ticket"],
            "code": sent["dev_code"],
        },
    ).json()
    token = {"Authorization": f"Bearer {logged_in['access_token']}"}

    bindings = client.get("/api/v1/auth/wechat/bindings", headers=token).json()
    assert len(bindings) == 1
    assert bindings[0]["phone"] == "138****0015"

    removed = client.delete(f"/api/v1/auth/wechat/bindings/{bindings[0]['id']}", headers=token)
    assert removed.status_code == 200, removed.text

    again = client.post("/api/v1/auth/wechat/login", json={"code": code, "state": state})
    assert again.json()["status"] == "bind_required"


def test_wechat_bind_password_mode(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    """短信通道不可用时的应急方式：用账号密码确认身份后绑定。"""
    monkeypatch.setenv("WECHAT_LOGIN_ENABLED", "true")
    monkeypatch.setenv("WECHAT_PROVIDER", "mock")
    monkeypatch.setenv("WECHAT_BIND_VERIFY_MODE", "password")
    get_settings.cache_clear()
    try:
        _create_user(client, username="wxuser5", phone="13800000016", password="password123")
        code, state = _authorize(client)
        bind_ticket = client.post(
            "/api/v1/auth/wechat/login", json={"code": code, "state": state}
        ).json()["bind_ticket"]

        wrong = client.post(
            "/api/v1/auth/wechat/bind/confirm",
            json={"bind_ticket": bind_ticket, "phone": "13800000016", "password": "bad-password"},
        )
        assert wrong.status_code == 401, wrong.text

        ok = client.post(
            "/api/v1/auth/wechat/bind/confirm",
            json={"bind_ticket": bind_ticket, "phone": "13800000016", "password": "password123"},
        )
        assert ok.status_code == 200, ok.text
        assert ok.json()["status"] == "logged_in"
    finally:
        get_settings.cache_clear()


# ---------------------------------------------------------------- 首次设置密码
# 改密页是登录后的强制闸门，而免密登录的人从未输入过密码。若无条件要求「当前密码」，
# 这类账号首次登录即死锁（UserUpdate 也不接 must_change_password，管理员没有接口能替他清掉）。


def _phone_login(client: TestClient, phone: str) -> dict:
    sent = _send_code(client, phone)
    response = client.post(
        "/api/v1/auth/phone/login",
        json={"phone": phone, "code": sent["dev_code"], "code_ticket": sent["code_ticket"]},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _change_password(client: TestClient, token: str, body: dict) -> object:
    return client.post(
        "/api/v1/auth/change-password",
        json=body,
        headers={"Authorization": f"Bearer {token}"},
    )


def test_passwordless_login_can_set_initial_password(client: TestClient) -> None:
    """免密登录 + 尚未自设密码：允许不提供当前密码，直接设新密码。"""
    created = _create_user(client, username="deadlock1", phone="13800000031")
    assert created["must_change_password"] is True

    logged = _phone_login(client, "13800000031")
    token = logged["access_token"]
    assert logged["user"]["must_change_password"] is True

    response = _change_password(client, token, {"new_password": "BrandNew@2026"})
    assert response.status_code == 200, response.text

    # 设完之后用新密码能登录，且强制改密标记已清除。
    relogin = client.post(
        "/api/v1/auth/login", json={"username": "deadlock1", "password": "BrandNew@2026"}
    )
    assert relogin.status_code == 200, relogin.text
    assert relogin.json()["user"]["must_change_password"] is False


def test_passwordless_session_cannot_skip_old_password_once_password_is_set(
    client: TestClient,
) -> None:
    """边界：设过密码之后，免密会话改密必须验旧密码，否则 token 泄露即可静默改密。"""
    _create_user(client, username="deadlock2", phone="13800000032")
    token = _phone_login(client, "13800000032")["access_token"]
    assert _change_password(client, token, {"new_password": "First@2026"}).status_code == 200

    # 同一个免密会话，此时 must_change_password 已为假
    response = _change_password(client, token, {"new_password": "Second@2026"})
    assert response.status_code == 401, response.text
    assert "原密码" in response.text

    ok = _change_password(client, token, {"old_password": "First@2026", "new_password": "Second@2026"})
    assert ok.status_code == 200, ok.text


def test_password_session_still_requires_old_password(client: TestClient) -> None:
    """回归：账号密码登录的会话，不提供当前密码一律拒绝。"""
    _create_user(client, username="deadlock3", phone="13800000033", password="Origin@2026")

    logged = client.post(
        "/api/v1/auth/login", json={"username": "deadlock3", "password": "Origin@2026"}
    )
    assert logged.status_code == 200, logged.text
    token = logged.json()["access_token"]

    assert _change_password(client, token, {"new_password": "Another@2026"}).status_code == 401
    wrong = _change_password(
        client, token, {"old_password": "not-the-password", "new_password": "Another@2026"}
    )
    assert wrong.status_code == 401, wrong.text
    assert "原密码" in wrong.text
    ok = _change_password(
        client, token, {"old_password": "Origin@2026", "new_password": "Another@2026"}
    )
    assert ok.status_code == 200, ok.text


def test_token_records_authentication_method(client: TestClient) -> None:
    """amr 必须如实记录来源：三种登录方式各自不同。"""
    from app.core.security import decode_token

    _create_user(client, username="amruser", phone="13800000034", password="Amr@2026")

    phone_token = _phone_login(client, "13800000034")["access_token"]
    assert decode_token(phone_token)["amr"] == "phone_code"

    password_token = client.post(
        "/api/v1/auth/login", json={"username": "amruser", "password": "Amr@2026"}
    ).json()["access_token"]
    assert decode_token(password_token)["amr"] == "password"


def test_legacy_token_without_amr_cannot_skip_old_password(client: TestClient) -> None:
    """老 token（1.0.3 之前签发，无 amr）按密码会话处理，不得借免密口子绕过旧密码。"""
    from app.core.security import encode_token

    created = _create_user(client, username="legacy1", phone="13800000035")
    assert created["must_change_password"] is True

    legacy = encode_token(
        {
            "sub": str(created["id"]),
            "username": "legacy1",
            "roles": ["OPERATOR"],
            "pool_ids": [],
            "team_ids": [],
            "owner_scope": "SELF",
        }
    )
    response = _change_password(client, legacy, {"new_password": "Legacy@2026"})
    assert response.status_code == 401, response.text


def test_token_with_unknown_amr_is_rejected(client: TestClient) -> None:
    """amr 只接受白名单值，伪造的认证方式直接按无效凭证处理。"""
    from app.core.security import encode_token

    created = _create_user(client, username="fakeamr", phone="13800000036")
    forged = encode_token(
        {
            "sub": str(created["id"]),
            "username": "fakeamr",
            "roles": ["OPERATOR"],
            "pool_ids": [],
            "team_ids": [],
            "owner_scope": "SELF",
            "amr": "totally-made-up",
        }
    )
    assert _change_password(client, forged, {"new_password": "Fake@2026"}).status_code == 401


# ---------------------------------------------------------------- H5（公众号网页授权）
# 手机在微信内没法扫自己的屏，桌面端的 qrconnect 在 H5 上是死路，故单开一条通道：
# 授权地址换成公众号的 oauth2/authorize，兑换 code 用公众号的 appid/secret。
# 两条通道的 code 由不同 appid 签发，混用必然失败，所以 channel 必须显式区分。


@pytest.fixture()
def wechat_h5_mock(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("WECHAT_H5_ENABLED", "true")
    monkeypatch.setenv("WECHAT_H5_PROVIDER", "mock")
    monkeypatch.setenv("WECHAT_BIND_VERIFY_MODE", "sms")
    monkeypatch.setenv("SMS_PROVIDER", "mock")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _h5_authorize(client: TestClient, redirect_uri: str = "http://127.0.0.1:4188/h5/"):
    return client.get(
        "/api/v1/auth/wechat/authorize",
        params={"channel": "h5", "redirect_uri": redirect_uri},
    )


def _mock_code_from(authorize_url: str) -> str:
    query = parse_qs(urlparse(authorize_url).query)
    return query["code"][0]


def test_login_methods_has_h5_block_and_off_by_default(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """H5 通道独立开关：默认关闭时必须明确返回「未启用」，而不是缺字段。"""
    monkeypatch.setenv("WECHAT_H5_ENABLED", "false")
    monkeypatch.setenv("WECHAT_H5_PROVIDER", "disabled")
    get_settings.cache_clear()
    data = client.get("/api/v1/auth/login-methods").json()
    assert data["wechat_h5"]["enabled"] is False
    assert data["wechat_h5"]["provider"] == "disabled"
    assert data["wechat_h5"]["reason"]


def test_h5_authorize_returns_channel_and_self_callback(
    client: TestClient, wechat_h5_mock
) -> None:
    """mock 通道把 code 直接回跳给自己，后续流程与真实通道完全一致。"""
    response = _h5_authorize(client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["channel"] == "h5"

    parsed = urlparse(body["authorize_url"])
    assert parsed.path.endswith("/h5/")
    query = parse_qs(parsed.query)
    assert query["code"][0].startswith("mock-")
    assert query["state"][0] == body["state"]


def test_h5_authorize_rejects_unknown_channel(client: TestClient, wechat_h5_mock) -> None:
    response = client.get("/api/v1/auth/wechat/authorize", params={"channel": "app"})
    assert response.status_code == 422, response.text


def test_h5_wechat_login_requires_binding_then_logs_in(
    client: TestClient, wechat_h5_mock
) -> None:
    """H5 首次登录同样只发 bind_ticket，绝不直接发 access_token。"""
    phone = "13800000041"
    _create_user(client, username="h5wx", phone=phone)

    authorized = _h5_authorize(client).json()
    first = client.post(
        "/api/v1/auth/wechat/login",
        json={"code": _mock_code_from(authorized["authorize_url"]), "state": authorized["state"], "channel": "h5"},
    )
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["status"] == "bind_required"
    assert body["access_token"] is None
    assert body["bind_ticket"]

    sent = client.post(
        "/api/v1/auth/wechat/bind/code",
        json={"bind_ticket": body["bind_ticket"], "phone": phone},
    )
    assert sent.status_code == 200, sent.text
    challenge = sent.json()

    confirmed = client.post(
        "/api/v1/auth/wechat/bind/confirm",
        json={
            "bind_ticket": body["bind_ticket"],
            "phone": phone,
            "code": challenge["dev_code"],
            "code_ticket": challenge["code_ticket"],
        },
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["access_token"]

    # 第二次：已绑定，直接登录，不再需要验证码。
    again_authorized = _h5_authorize(client).json()
    second = client.post(
        "/api/v1/auth/wechat/login",
        json={
            "code": _mock_code_from(again_authorized["authorize_url"]),
            "state": again_authorized["state"],
            "channel": "h5",
        },
    )
    assert second.status_code == 200, second.text
    assert second.json()["status"] == "logged_in"
    assert second.json()["access_token"]


def test_h5_login_rejected_when_channel_disabled(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """通道关掉后，即使拿着合法的 mock code 也必须拒绝——开关是准入口径。"""
    monkeypatch.setenv("WECHAT_H5_ENABLED", "true")
    monkeypatch.setenv("WECHAT_H5_PROVIDER", "mock")
    get_settings.cache_clear()
    authorized = _h5_authorize(client).json()

    monkeypatch.setenv("WECHAT_H5_ENABLED", "false")
    monkeypatch.setenv("WECHAT_H5_PROVIDER", "disabled")
    get_settings.cache_clear()

    response = client.post(
        "/api/v1/auth/wechat/login",
        json={"code": _mock_code_from(authorized["authorize_url"]), "state": authorized["state"], "channel": "h5"},
    )
    assert response.status_code == 422, response.text


def test_web_channel_still_works_after_h5_added(client: TestClient, wechat_mock) -> None:
    """回归：新增 H5 通道不得改变桌面扫码通道的行为（默认 channel=web）。"""
    authorized = client.get(
        "/api/v1/auth/wechat/authorize", params={"redirect_uri": "http://127.0.0.1:4188/"}
    ).json()
    assert authorized["channel"] == "web"
    response = client.post(
        "/api/v1/auth/wechat/login",
        json={"code": _mock_code_from(authorized["authorize_url"]), "state": authorized["state"]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] in {"logged_in", "bind_required"}
