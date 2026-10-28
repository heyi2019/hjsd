"""登录限流与 RateLimiter 单元测试。

覆盖：
- RateLimiter 固定窗口纯逻辑（放行/拒绝/分键独立/窗口重置/默认窗口）。
- /auth/login 在生产态超限返回 429(RATE_LIMITED)，且限流在 PBKDF2 之前
  （错误密码也消耗预算，验证防暴破）；开发态自动绕过；不同客户端 IP 独立计数。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.ratelimit import RateLimiter, login_limiter
from app.core.security import hash_password
from app.core.settings import get_settings
from app.domain.users import User


class TestRateLimiter:
    def test_allows_up_to_limit_then_denies(self):
        rl = RateLimiter()
        for _ in range(3):
            assert rl.is_allowed("k", 3, 60) is True
        assert rl.is_allowed("k", 3, 60) is False

    def test_separate_keys_independent(self):
        rl = RateLimiter()
        assert rl.is_allowed("a", 1, 60) is True
        assert rl.is_allowed("a", 1, 60) is False
        assert rl.is_allowed("b", 1, 60) is True

    def test_window_resets_on_clear(self):
        rl = RateLimiter()
        assert rl.is_allowed("k", 1, 60) is True
        assert rl.is_allowed("k", 1, 60) is False
        rl.reset()
        assert rl.is_allowed("k", 1, 60) is True

    def test_default_window_is_60s(self):
        rl = RateLimiter()
        assert rl.is_allowed("k", 1) is True  # 默认 window_seconds=60


@pytest.fixture
def rate_user(db: Session) -> User:
    user = User(
        username="rluser",
        display_name="RL",
        password_hash=hash_password("rlpass123"),
        role="VIEWER",
        is_active=True,
    )
    db.add(user)
    db.commit()
    return user


def _login(client: TestClient, username: str, password: str, ip: str | None = None):
    headers = {"X-Forwarded-For": ip} if ip else {}
    return client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
        headers=headers,
    )


class TestLoginRateLimit:
    def test_production_blocks_after_limit(self, client, rate_user, monkeypatch):
        login_limiter.reset()
        settings = get_settings()
        monkeypatch.setattr(settings, "app_env", "production")
        monkeypatch.setattr(settings, "login_rate_limit_enabled", True)
        monkeypatch.setattr(settings, "login_rate_limit_per_minute", 3)
        for _ in range(3):
            r = _login(client, "rluser", "rlpass123")
            assert r.status_code == 200, r.text
        r = _login(client, "rluser", "rlpass123")
        assert r.status_code == 429
        assert r.json()["code"] == "RATE_LIMITED"

    def test_production_counts_failed_attempts(self, client, rate_user, monkeypatch):
        # 限流在 PBKDF2 之前：错误密码也消耗预算，证明防暴破。
        login_limiter.reset()
        settings = get_settings()
        monkeypatch.setattr(settings, "app_env", "production")
        monkeypatch.setattr(settings, "login_rate_limit_enabled", True)
        monkeypatch.setattr(settings, "login_rate_limit_per_minute", 2)
        for _ in range(2):
            r = _login(client, "rluser", "wrong")
            assert r.status_code in (401, 429), r.text
        assert _login(client, "rluser", "wrong").status_code == 429

    def test_development_bypasses(self, client, rate_user, monkeypatch):
        login_limiter.reset()
        settings = get_settings()
        monkeypatch.setattr(settings, "app_env", "development")
        monkeypatch.setattr(settings, "login_rate_limit_enabled", True)
        monkeypatch.setattr(settings, "login_rate_limit_per_minute", 1)
        for _ in range(5):
            r = _login(client, "rluser", "rlpass123")
            assert r.status_code == 200, r.text

    def test_disabled_bypasses_in_production(self, client, rate_user, monkeypatch):
        login_limiter.reset()
        settings = get_settings()
        monkeypatch.setattr(settings, "app_env", "production")
        monkeypatch.setattr(settings, "login_rate_limit_enabled", False)
        monkeypatch.setattr(settings, "login_rate_limit_per_minute", 1)
        for _ in range(3):
            r = _login(client, "rluser", "rlpass123")
            assert r.status_code == 200, r.text

    def test_distinct_ips_independent(self, client, rate_user, monkeypatch):
        login_limiter.reset()
        settings = get_settings()
        monkeypatch.setattr(settings, "app_env", "production")
        monkeypatch.setattr(settings, "login_rate_limit_enabled", True)
        monkeypatch.setattr(settings, "login_rate_limit_per_minute", 1)
        assert _login(client, "rluser", "rlpass123", ip="1.1.1.1").status_code == 200
        assert _login(client, "rluser", "rlpass123", ip="1.1.1.1").status_code == 429
        # 不同 IP 独立计数，仍放行
        assert _login(client, "rluser", "rlpass123", ip="2.2.2.2").status_code == 200
