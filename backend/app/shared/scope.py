"""shared.scope：数据范围（owner scope）口径——可见哪些负责人名下的记录。

2026-11-18 架构归位：`owner_scope_ids` / `owner_scope_filter` 原在
`app/core/security.py`，后因需要查 `User`（TEAM 成员关系）上移到
`app/auth/session.py`。但它同时被 auth / shared / stocks / parties 四个包引用，
放 auth 会让 shared 反向依赖 auth（形成 `auth ↔ shared` 双向环）。

归位到 shared 的理由：它是**数据范围口径**，不属于认证域，也不属于任何业务域——
被 ≥2 个业务域直接引用，且只依赖 core（CurrentUser）与 domain（User ORM）。

**口径不变**：可见性判定仍是 owner_scope + is_admin + TEAM 成员关系，
与迁移前逐字一致。
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import ColumnElement, cast, or_, select
from sqlalchemy.dialects.postgresql import JSONB

from app.core.security import CurrentUser
from app.domain.users import User


def owner_scope_ids(session: Any, user: CurrentUser) -> set[int] | None:
    """Resolve the owner ids visible to a user, including TEAM membership."""
    if user.is_admin or user.owner_scope == "ALL":
        return None
    if user.owner_scope != "TEAM" or not user.team_ids:
        return {user.id}

    matching_team = or_(*(cast(User.team_ids, JSONB).contains([team_id]) for team_id in user.team_ids))
    return {user.id, *session.scalars(select(User.id).where(matching_team)).all()}


def owner_scope_filter(
    column: ColumnElement, user: CurrentUser, session: Any | None = None
) -> ColumnElement | None:
    """Return a SQL predicate for owner-scoped tables; None means unrestricted."""
    ids = owner_scope_ids(session, user) if session is not None else None
    if ids is None and (user.is_admin or user.owner_scope == "ALL"):
        return None
    return column.in_(ids or {user.id})


__all__ = ["owner_scope_filter", "owner_scope_ids"]
