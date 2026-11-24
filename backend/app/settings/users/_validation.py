"""settings.users._validation：用户/团队写入共用的字段校验与审计快照。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import Conflict, Validation
from app.core.phone import assert_valid_phone, normalize_phone
from app.domain.foundation import Pool
from app.domain.users import Team, User

_USER_FIELDS = (
    "username", "display_name", "role", "owner_scope", "pool_ids", "team_ids",
    "phone", "hired_on", "note", "is_active", "deactivated_on", "handover_user_id", "handover_note",
)
_USER_MUTABLE_FIELDS = frozenset(
    {
        "display_name", "role", "owner_scope", "pool_ids", "team_ids", "phone", "note",
        "is_active", "handover_user_id", "handover_note",
    }
)
_TEAM_MUTABLE_FIELDS = frozenset({"name", "description", "is_active"})


def _required_text(value: object, *, message: str) -> str:
    if not isinstance(value, str):
        raise Validation(message)
    normalized = value.strip()
    if not normalized:
        raise Validation(message)
    return normalized


def _required_password(value: object) -> str:
    if not isinstance(value, str) or len(value) < 8:
        raise Validation("密码至少需要 8 位", details={"field": "password"})
    if len(value) > 128:
        raise Validation("密码不能超过 128 位", details={"field": "password"})
    return value


def _required_bool(value: object, *, message: str) -> bool:
    if not isinstance(value, bool):
        raise Validation(message, details={"field": "is_active"})
    return value


def _optional_phone(value: object) -> str | None:
    """用户名下的手机号：空白视为未配置，非空值统一归一化并校验。"""
    if value is None:
        return None
    if not isinstance(value, str):
        raise Validation("手机号必须为文本", details={"field": "phone"})
    normalized = normalize_phone(value)
    if not normalized:
        return None
    assert_valid_phone(normalized)
    return normalized


def _check_phone_unique(session: Session, phone: str | None, *, exclude_user_id: int | None = None) -> None:
    if phone is None:
        return
    stmt = select(User.id).where(User.phone == phone)
    if exclude_user_id is not None:
        stmt = stmt.where(User.id != exclude_user_id)
    if session.scalar(stmt) is not None:
        raise Conflict("手机号已存在", details={"field": "phone"})


def _validate_id_list(value: object, *, label: str) -> list[int] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        raise Validation(f"{label} ID 列表格式无效", details={"field": label})
    if any(isinstance(item, bool) or not isinstance(item, int) or item <= 0 for item in value):
        raise Validation(f"{label} ID 必须为正整数", details={"field": label})
    if len(value) != len(set(value)):
        raise Validation(f"{label} ID 不能重复", details={"field": label})
    return value


def _user_snapshot(user: User) -> dict[str, object]:
    snapshot = {field: getattr(user, field) for field in _USER_FIELDS}
    if user.hired_on is not None:
        snapshot["hired_on"] = user.hired_on.isoformat()
    if user.deactivated_on is not None:
        snapshot["deactivated_on"] = user.deactivated_on.isoformat()
    return snapshot


def _validate_handover_target(session: Session, user_id: int, target_id: object) -> User:
    if isinstance(target_id, bool) or not isinstance(target_id, int) or target_id <= 0:
        raise Validation("交接目标用户 ID 必须为正整数", details={"field": "handover_user_id"})
    if target_id == user_id:
        raise Validation("交接目标不能是本人", details={"field": "handover_user_id"})
    target = session.get(User, target_id)
    if target is None:
        raise Validation("交接目标用户不存在", details={"field": "handover_user_id", "user_id": target_id})
    if not target.is_active:
        raise Validation("交接目标必须是启用用户", details={"field": "handover_user_id", "user_id": target_id})
    return target


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


def _check_pool_ids(session: Session, pool_ids: list[int] | None) -> None:
    if pool_ids is None:
        return
    requested = set(pool_ids)
    actual = {
        row[0]
        for row in session.execute(select(Pool.id).where(Pool.id.in_(requested))).all()
    }
    if actual != requested:
        raise Validation("资金账户不存在", details={"pool_ids": sorted(requested - actual)})
