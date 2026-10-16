"""auth.service：登录账号、团队及密码变更的业务写入。

路由只负责鉴权、参数接收和响应映射；用户/团队写入与审计在本 Service 内完成，
由请求边界统一提交，避免出现业务已写入但审计遗漏的分裂事务。
"""
from __future__ import annotations

from collections.abc import Mapping

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import AuthError, Conflict, Validation
from app.core.security import ALL_ROLES, hash_password, verify_password
from app.domain.enums import AuditAction
from app.domain.users import RevokedToken, Team, User

_USER_FIELDS = ("username", "display_name", "role", "owner_scope", "pool_ids", "team_ids", "phone", "note", "is_active")


def _user_snapshot(user: User) -> dict[str, object]:
    return {field: getattr(user, field) for field in _USER_FIELDS}


def _team_snapshot(team: Team) -> dict[str, object]:
    return {
        "code": team.code,
        "name": team.name,
        "description": team.description,
        "is_active": team.is_active,
    }


def _check_team_ids(session: Session, team_ids: list[int] | None) -> None:
    if team_ids is None:
        return
    requested = set(team_ids)
    actual = {
        row[0]
        for row in session.execute(select(Team.id).where(Team.id.in_(requested))).all()
    }
    if actual != requested:
        raise Validation("团队不存在", details={"team_ids": sorted(requested - actual)})


def create_user(
    session: Session,
    *,
    username: str,
    display_name: str,
    password: str,
    role: str,
    owner_scope: str,
    pool_ids: list[int],
    team_ids: list[int],
    phone: str | None,
    note: str | None,
    actor: str,
) -> User:
    if role not in ALL_ROLES:
        raise Validation("无效角色")
    normalized_username = username.strip()
    if session.scalar(select(User).where(User.username == normalized_username)):
        raise Conflict("用户名已存在")
    _check_team_ids(session, team_ids)
    user = User(
        username=normalized_username,
        display_name=display_name,
        password_hash=hash_password(password),
        role=role,
        owner_scope=owner_scope,
        phone=phone,
        note=note,
        pool_ids=pool_ids,
        team_ids=team_ids,
        must_change_password=True,
    )
    session.add(user)
    session.flush()
    record_audit(
        session,
        action=AuditAction.USER_CREATE,
        entity_type="user",
        entity_id=user.id,
        actor=actor,
        after=_user_snapshot(user),
    )
    return user


def update_user(
    session: Session,
    user_id: int,
    *,
    changes: Mapping[str, object],
    actor: str,
) -> User:
    user = session.get(User, user_id)
    if user is None:
        raise Validation("用户不存在")
    _check_team_ids(session, changes.get("team_ids") if "team_ids" in changes else None)  # type: ignore[arg-type]
    if "role" in changes and changes["role"] not in ALL_ROLES:
        raise Validation("无效角色")
    before = _user_snapshot(user)
    for key, value in changes.items():
        setattr(user, key, value)
    session.flush()
    record_audit(
        session,
        action=AuditAction.USER_UPDATE,
        entity_type="user",
        entity_id=user.id,
        actor=actor,
        before=before,
        after=_user_snapshot(user),
    )
    return user


def change_password(
    session: Session,
    user_id: int,
    *,
    old_password: str,
    new_password: str,
    actor: str,
) -> None:
    user = session.get(User, user_id)
    if user is None or not verify_password(old_password, user.password_hash):
        raise AuthError("原密码错误")
    user.password_hash = hash_password(new_password)
    user.must_change_password = False
    session.flush()
    record_audit(
        session,
        action=AuditAction.PASSWORD_CHANGE,
        entity_type="user",
        entity_id=user.id,
        actor=actor,
    )


def reset_password(
    session: Session,
    user_id: int,
    *,
    password: str,
    actor: str,
) -> None:
    user = session.get(User, user_id)
    if user is None:
        raise Validation("用户不存在")
    user.password_hash = hash_password(password)
    user.must_change_password = True
    session.flush()
    record_audit(
        session,
        action=AuditAction.PASSWORD_RESET,
        entity_type="user",
        entity_id=user.id,
        actor=actor,
    )


def revoke_token(session: Session, *, jti: str, expires_at: int) -> None:
    """登记已退出的 JWT；幂等交给主键 merge。"""
    session.merge(RevokedToken(jti=jti, expires_at=expires_at))


def create_team(
    session: Session,
    *,
    code: str,
    name: str,
    description: str | None,
    actor: str,
) -> Team:
    normalized_code = code.strip().upper()
    if session.scalar(select(Team).where(Team.code == normalized_code)):
        raise Conflict("团队编码已存在")
    team = Team(code=normalized_code, name=name.strip(), description=description)
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
    before = _team_snapshot(team)
    for key, value in changes.items():
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


__all__ = [
    "change_password",
    "create_team",
    "create_user",
    "revoke_token",
    "reset_password",
    "update_team",
    "update_user",
]
