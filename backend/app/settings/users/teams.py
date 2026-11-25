"""settings.users.teams：团队的写入。"""
from __future__ import annotations

from collections.abc import Mapping

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import Validation
from app.domain.enums import AuditAction
from app.domain.users import Team
from app.shared.option_codes import allocate_option_code
from app.settings.users._validation import (
    _TEAM_MUTABLE_FIELDS,
    _required_bool,
    _required_text,
    _team_snapshot,
)


def create_team(
    session: Session,
    *,
    name: str,
    description: str | None,
    actor: str,
) -> Team:
    normalized_name = _required_text(name, message="团队名称不能为空")
    normalized_code = allocate_option_code(session, "team", "team", list(session.scalars(select(Team.code))))
    team = Team(code=normalized_code, name=normalized_name, description=description)
    session.add(team)
    session.flush()
    record_audit(
        session,
        action=AuditAction.TEAM_CREATE,
        entity_type="team",
        entity_id=team.id,
        actor=actor,
        after=_team_snapshot(team),
    )
    return team


def update_team(
    session: Session,
    team_id: int,
    *,
    changes: Mapping[str, object],
    actor: str,
) -> Team:
    team = session.get(Team, team_id)
    if team is None:
        raise Validation("团队不存在")
    unsupported = sorted(set(changes) - _TEAM_MUTABLE_FIELDS)
    if unsupported:
        raise Validation("团队更新字段不受支持", details={"fields": unsupported})
    normalized_changes = dict(changes)
    if "name" in normalized_changes:
        normalized_changes["name"] = _required_text(
            normalized_changes["name"], message="团队名称不能为空"
        )
    if "is_active" in normalized_changes:
        normalized_changes["is_active"] = _required_bool(
            normalized_changes["is_active"], message="启用状态必须为布尔值"
        )
    before = _team_snapshot(team)
    for key, value in normalized_changes.items():
        setattr(team, key, value)
    session.flush()
    record_audit(
        session,
        action=AuditAction.TEAM_UPDATE,
        entity_type="team",
        entity_id=team.id,
        actor=actor,
        before=before,
        after=_team_snapshot(team),
    )
    return team
