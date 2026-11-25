"""Associate historical actor names with the same user after a login rename."""
from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import String, cast, or_, select
from sqlalchemy.orm import Session

from app.domain.enums import AuditAction
from app.domain.foundation import AuditLog
from app.domain.users import User


def _former_usernames():
    previous = AuditLog.before_json["username"].as_string()
    return select(AuditLog.entity_id.label("user_key"), previous.label("username")).where(
        AuditLog.entity_type == "user",
        AuditLog.action == AuditAction.USER_UPDATE.value,
        previous != AuditLog.after_json["username"].as_string(),
    )


def user_id_for_actor(session: Session, username: str, *, active_only: bool = False) -> int | None:
    former = _former_usernames().subquery()
    former_ids = select(former.c.user_key).where(former.c.username == username)
    stmt = select(User.id).where(or_(User.username == username, cast(User.id, String).in_(former_ids)))
    if active_only:
        stmt = stmt.where(User.is_active.is_(True))
    return session.scalar(stmt)


def actor_names(session: Session, usernames: Sequence[str]) -> list[str]:
    """Expand selected usernames to their original actor labels, without changing history."""
    names = select(
        cast(User.id, String).label("user_key"), User.username.label("username"),
    ).union_all(_former_usernames()).subquery()
    selected = select(names.c.user_key).where(names.c.username.in_(usernames))
    matching = session.scalars(select(names.c.username).where(names.c.user_key.in_(selected)))
    return list(dict.fromkeys([*usernames, *matching]))
