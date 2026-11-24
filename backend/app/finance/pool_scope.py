"""资金域内按账户授权收窄查询范围。"""
from __future__ import annotations

from collections.abc import Iterable

from app.core.security import CurrentUser


def visible_pool_ids(
    user: CurrentUser | None,
    *,
    pool_id: int | None = None,
    pool_ids: Iterable[int] | None = None,
) -> list[int] | None:
    """None 表示不限制；空列表表示没有可见账户。单个账户参数优先。"""
    if pool_id is not None:
        return [pool_id] if user is None or user.can_see_pool(pool_id) else []
    if pool_ids is not None:
        return [item for item in pool_ids if user is None or user.can_see_pool(item)]
    if user is None or user.is_admin or user.owner_scope == "ALL":
        return None
    return sorted(user.pool_ids)
