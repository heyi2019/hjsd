"""RATELIMIT-01 登录限流与 RateLimiter 单元测试。

覆盖：
- RateLimiter 固定窗口纯逻辑（放行/拒绝/分键独立/窗口重置/默认窗口）。
- /auth/login 在生产态超限返回 429(RATE_LIMITED)，且限流在 PBKDF2 之前
  （错误密码也消耗预算，验证防暴破）；开发态自动绕过；不同客户端 IP 独立计数。
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.ratelimit import RateLimiter, login_limiter
from app.core.errors import RateLimitUnavailable
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

    def test_shared_redis_limit_across_instances(self):
        from app.core.ratelimit import RedisRateLimiter
        url = os.environ.get("TEST_REDIS_URL")
        if not url:
            pytest.skip("需要独立的 TEST_REDIS_URL 验证跨实例原子限流")
        first, second = RedisRateLimiter(url), RedisRateLimiter(url)
        key = f"test:{uuid.uuid4()}"
        with ThreadPoolExecutor(max_workers=8) as executor:
            allowed = list(executor.map(lambda index: (first if index % 2 else second).is_allowed(key, 5, 60), range(20)))
        assert sum(allowed) == 5
        assert not second.is_allowed(key, 5, 60)
        assert first.is_allowed(key + ":other", 1, 60)
        expiry_key = key + ":expiry"
        assert first.is_allowed(expiry_key, 1, 1)
        assert not second.is_allowed(expiry_key, 1, 1)
        time.sleep(1.1)
        assert second.is_allowed(expiry_key, 1, 1)
        process_key = key + ":process"
        env = {**os.environ, "RATE_TEST_KEY": process_key}
        script = "import os; from app.core.ratelimit import RedisRateLimiter; raise SystemExit(0 if RedisRateLimiter(os.environ['TEST_REDIS_URL']).is_allowed(os.environ['RATE_TEST_KEY'], 1, 60) else 1)"
        assert subprocess.run([sys.executable, "-c", script], env=env).returncode == 0
        assert subprocess.run([sys.executable, "-c", script], env=env).returncode == 1

    def test_customer_rate_limiter_fails_closed_without_redis_in_production(self, monkeypatch):
        from app.core import ratelimit
        monkeypatch.setattr(ratelimit, "get_settings", lambda: SimpleNamespace(is_production=True, is_development=False, customer_rate_limit_redis_url=""), raising=False)
        with pytest.raises(RateLimitUnavailable) as exc:
            ratelimit.CustomerRateLimiter().is_allowed("read:1", 10)
        assert getattr(exc.value, "http_status", None) == 503

    def test_production_customer_limit_is_shared_between_workers(self, monkeypatch):
        from app.core import ratelimit
        url = os.environ.get("TEST_REDIS_URL")
        if not url:
            pytest.skip("需要独立的 TEST_REDIS_URL 验证生产限流")
        monkeypatch.setattr(ratelimit, "get_settings", lambda: SimpleNamespace(is_production=True, is_development=False, customer_rate_limit_redis_url=url))
        key = f"read:test:{uuid.uuid4()}"
        assert ratelimit.CustomerRateLimiter().is_allowed(key, 1)
        assert not ratelimit.CustomerRateLimiter().is_allowed(key, 1)

    def test_production_login_limit_is_shared_between_workers(self, monkeypatch):
        from app.core import ratelimit
        url = os.environ.get("TEST_REDIS_URL")
        if not url:
            pytest.skip("需要独立的 TEST_REDIS_URL 验证生产登录限流")
        monkeypatch.setattr(ratelimit, "get_settings", lambda: SimpleNamespace(is_development=False, customer_rate_limit_redis_url=url))
        key = f"login:test:{uuid.uuid4()}"
        assert ratelimit.LoginRateLimiter().is_allowed(key, 1)
        assert not ratelimit.LoginRateLimiter().is_allowed(key, 1)
        assert ratelimit.CustomerRateLimiter().is_allowed(key, 1)
        process_key = f"login:process:{uuid.uuid4()}"
        env = {**os.environ, "RATE_TEST_KEY": process_key, "APP_ENV": "production", "JWT_SECRET_KEY": "test-login-secret-0123456789-abcdef", "CUSTOMER_RATE_LIMIT_REDIS_URL": url}
        script = "import os; from app.core.ratelimit import LoginRateLimiter; raise SystemExit(0 if LoginRateLimiter().is_allowed(os.environ['RATE_TEST_KEY'], 1, 60) else 1)"
        assert subprocess.run([sys.executable, "-c", script], env=env).returncode == 0
        assert subprocess.run([sys.executable, "-c", script], env=env).returncode == 1

    def test_production_login_limit_fails_closed_without_redis(self, monkeypatch):
        from app.core import ratelimit
        monkeypatch.setattr(ratelimit, "get_settings", lambda: SimpleNamespace(is_development=False, customer_rate_limit_redis_url=""))
        with pytest.raises(RateLimitUnavailable, match="登录保护"):
            ratelimit.LoginRateLimiter().is_allowed("login:test", 1)

    def test_non_development_environment_cannot_bypass_shared_limiter(self, monkeypatch):
        from app.core import ratelimit
        monkeypatch.setattr(ratelimit, "get_settings", lambda: SimpleNamespace(is_production=False, is_development=False, customer_rate_limit_redis_url=""))
        with pytest.raises(RateLimitUnavailable):
            ratelimit.CustomerRateLimiter().is_allowed("read:1", 1)

    def test_redis_connection_failure_is_a_service_error(self):
        from app.core.ratelimit import RedisRateLimiter
        with pytest.raises(RateLimitUnavailable) as exc:
            RedisRateLimiter("redis://127.0.0.1:1/0").is_allowed("read:1", 1)
        assert getattr(exc.value, "http_status", None) == 503


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
        "/api/auth/login",
        json={"username": username, "password": password},
        headers=headers,
    )


class TestLoginRateLimit:
    @pytest.fixture(autouse=True)
    def isolated_shared_counter(self, monkeypatch):
        from app.settings.auth import router as auth
        url = os.environ.get("TEST_REDIS_URL")
        if not url:
            pytest.skip("需要独立的 TEST_REDIS_URL 验证登录限流")
        monkeypatch.setattr(get_settings(), "customer_rate_limit_redis_url", url)
        original = auth._client_ip
        prefix = uuid.uuid4().hex
        monkeypatch.setattr(auth, "_client_ip", lambda request: f"{prefix}:{original(request)}")

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
