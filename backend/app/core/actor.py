"""审计与输出共用的操作人名称；各域以 `_actor` 别名导入，调用点口径不变。"""
from __future__ import annotations

from app.core.security import CurrentUser


def actor_name(user: CurrentUser) -> str:
    return user.username
