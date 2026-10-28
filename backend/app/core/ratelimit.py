"""core.ratelimit：进程内固定窗口限流器（登录防暴破用）。

设计取舍：
- 进程内计数，线程安全；uvicorn --workers N 下每 worker 各自独立计数。
  对「登录暴力破解」场景足够（攻击者通常来自同一源 IP，单进程即可拦），
  若需跨进程严格一致再换 Redis 等共享存储。
- 固定窗口（window 内前 N 次放行，第 N+1 次起拒绝，窗口到期重置），
  实现简单、零依赖，满足登录限流需求。
"""
from __future__ import annotations

import threading
import time


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


# 登录接口共享的限流器单例。
login_limiter = RateLimiter()
