"""固定窗口限流：登录与客户访问在生产使用 Redis 共享计数。

设计取舍：
- 生产环境使用共享 Redis，故障时拒绝访问；开发环境可使用进程内计数。
- 两者均为固定窗口：窗口内前 N 次放行，到期后重置。
"""
from __future__ import annotations

import threading
import time
from functools import lru_cache

from redis import Redis
from redis.exceptions import RedisError

from app.core.errors import RateLimitUnavailable
from app.core.settings import get_settings


class RateLimiter:
    """固定窗口限流器。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # key -> (window_start_monotonic, count)
        self._windows: dict[str, tuple[float, int]] = {}

    def is_allowed(self, key: str, limit: int, window_seconds: int = 60) -> bool:
        """返回该 key 当前是否允许请求；同时记录本次计数。"""
        now = time.monotonic()
        with self._lock:
            start, count = self._windows.get(key, (now, 0))
            if now - start >= window_seconds:
                start, count = now, 0
            if count >= limit:
                self._windows[key] = (start, count)
                return False
            self._windows[key] = (start, count + 1)
            return True

    def reset(self) -> None:
        """清空所有计数（主要供测试使用）。"""
        with self._lock:
            self._windows.clear()


class RedisRateLimiter:
    """用 Redis 原子脚本在多个进程间共享固定窗口。"""

    _SCRIPT = """
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('PTTL', KEYS[1]) < 0 then
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
if count <= tonumber(ARGV[1]) then return 1 end
return 0
"""

    def __init__(self, url: str, *, purpose: str = "customer") -> None:
        self._redis = Redis.from_url(url, socket_connect_timeout=1, socket_timeout=1)
        self._prefix = f"heijin:{purpose}-rate:v1:"
        self._unavailable = "登录保护暂不可用，请稍后重试" if purpose == "login" else "客户访问保护暂不可用，请稍后重试"

    def is_allowed(self, key: str, limit: int, window_seconds: int = 60) -> bool:
        try:
            return bool(self._redis.eval(self._SCRIPT, 1, f"{self._prefix}{key}", limit, window_seconds * 1000))
        except RedisError as exc:
            raise RateLimitUnavailable(self._unavailable) from exc


@lru_cache(maxsize=4)
def _redis_limiter(url: str, purpose: str = "customer") -> RedisRateLimiter:
    return RedisRateLimiter(url, purpose=purpose)


class CustomerRateLimiter:
    """非开发环境必须共享计数；开发环境可使用进程内计数。"""

    def __init__(self) -> None:
        self._local = RateLimiter()

    def is_allowed(self, key: str, limit: int, window_seconds: int = 60) -> bool:
        settings = get_settings()
        url = settings.customer_rate_limit_redis_url.strip()
        if url:
            try:
                return _redis_limiter(url).is_allowed(key, limit, window_seconds)
            except ValueError as exc:
                raise RateLimitUnavailable("客户访问保护配置无效，请联系管理员") from exc
        if not settings.is_development:
            raise RateLimitUnavailable("客户访问保护未配置，请联系管理员")
        return self._local.is_allowed(key, limit, window_seconds)


class LoginRateLimiter:
    """复用部署中的 Redis，登录与客户访问使用独立键空间。"""

    def __init__(self) -> None:
        self._local = RateLimiter()

    def is_allowed(self, key: str, limit: int, window_seconds: int = 60) -> bool:
        settings = get_settings()
        url = settings.customer_rate_limit_redis_url.strip()
        if url:
            try:
                return _redis_limiter(url, "login").is_allowed(key, limit, window_seconds)
            except ValueError as exc:
                raise RateLimitUnavailable("登录保护配置无效，请联系管理员") from exc
        if not settings.is_development:
            raise RateLimitUnavailable("登录保护未配置，请联系管理员")
        return self._local.is_allowed(key, limit, window_seconds)

    def reset(self) -> None:
        self._local.reset()


login_limiter = LoginRateLimiter()
