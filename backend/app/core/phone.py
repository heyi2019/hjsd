"""手机号格式化与校验。

手机号是用户资料字段，不属于登录通道；放在 core 供用户管理和客户资料共用。
"""
from __future__ import annotations

import re

from app.core.errors import Validation

_PHONE_RE = re.compile(r"^1[3-9]\d{9}$")


def normalize_phone(raw: object) -> str:
    """去除常见分隔符与中国大陆区号前缀。"""
    text = "" if raw is None else str(raw)
    compact = re.sub(r"[\s\-()]", "", text)
    if compact.startswith("+86"):
        compact = compact[3:]
    elif compact.startswith("0086"):
        compact = compact[4:]
    elif compact.startswith("86") and len(compact) == 13:
        compact = compact[2:]
    return compact


def assert_valid_phone(phone: str) -> None:
    if not _PHONE_RE.match(phone):
        raise Validation("请输入正确的 11 位手机号")


__all__ = ["assert_valid_phone", "normalize_phone"]
