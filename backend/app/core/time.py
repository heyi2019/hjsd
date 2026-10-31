"""应用时间工具：数据库记录统一保留到秒。"""
from __future__ import annotations

from datetime import datetime


def now_second() -> datetime:
    """返回本地无时区当前时间，精确到秒。"""
    return datetime.now().replace(microsecond=0)


def now_utc_second_naive() -> datetime:
    """返回 UTC 无时区当前时间，精确到秒。"""
    from datetime import UTC

    return datetime.now(UTC).replace(tzinfo=None, microsecond=0)


__all__ = ["now_second", "now_utc_second_naive"]
