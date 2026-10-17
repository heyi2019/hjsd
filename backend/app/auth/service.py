"""auth.service：登录账号、团队及密码变更的业务写入。

路由只负责鉴权、参数接收和响应映射；用户/团队写入与审计在本 Service 内完成，
由请求边界统一提交，避免出现业务已写入但审计遗漏的分裂事务。
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import AuthError, Conflict, Validation
from app.core.security import ALL_ROLES, OWNER_SCOPES, hash_password, verify_password
from app.domain.enums import AuditAction
from app.domain.foundation import Pool
from app.domain.trade import Order
from app.domain.enums import OrderStatus
from app.domain.users import RevokedToken, Team, User

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
    if value is None:
        return None
    if not isinstance(value, str):
        raise Validation("手机号必须为文本", details={"field": "phone"})
    normalized = value.strip()
    return normalized or None


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
        raise Validation("资金池不存在", details={"pool_ids": sorted(requested - actual)})


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
    if not isinstance(role, str) or role not in ALL_ROLES:
        raise Validation("无效角色")
    if not isinstance(owner_scope, str) or owner_scope not in OWNER_SCOPES:
        raise Validation("无效数据范围")
    normalized_username = _required_text(username, message="用户名不能为空")
    normalized_display_name = _required_text(display_name, message="显示名称不能为空")
    password = _required_password(password)
    pool_ids = _validate_id_list(pool_ids, label="资金池") or []
    team_ids = _validate_id_list(team_ids, label="团队") or []
    if session.scalar(select(User).where(User.username == normalized_username)):
        raise Conflict("用户名已存在")
    phone = _optional_phone(phone)
    _check_phone_unique(session, phone)
    _check_pool_ids(session, pool_ids)
    _check_team_ids(session, team_ids)
    user = User(
        username=normalized_username,
        display_name=normalized_display_name,
        password_hash=hash_password(password),
        role=role,
        owner_scope=owner_scope,
        phone=phone,
        hired_on=date.today(),
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
    unsupported = sorted(set(changes) - _USER_MUTABLE_FIELDS)
    if unsupported:
        raise Validation("用户更新字段不受支持", details={"fields": unsupported})
    handover_fields = {"handover_user_id", "handover_note"} & set(changes)
    if handover_fields and changes.get("is_active") is not False:
        raise Validation("交接字段只能随停用提交", details={"fields": sorted(handover_fields)})
    if "pool_ids" in changes:
        changes = {**changes, "pool_ids": _validate_id_list(changes["pool_ids"], label="资金池")}
    if "team_ids" in changes:
        changes = {**changes, "team_ids": _validate_id_list(changes["team_ids"], label="团队")}
    _check_pool_ids(session, changes.get("pool_ids") if "pool_ids" in changes else None)  # type: ignore[arg-type]
    _check_team_ids(session, changes.get("team_ids") if "team_ids" in changes else None)  # type: ignore[arg-type]
    if "role" in changes and (
        not isinstance(changes["role"], str) or changes["role"] not in ALL_ROLES
    ):
        raise Validation("无效角色")
    if "owner_scope" in changes and (
        not isinstance(changes["owner_scope"], str)
        or changes["owner_scope"] not in OWNER_SCOPES
    ):
        raise Validation("无效数据范围")
    normalized_changes = dict(changes)
    if "display_name" in normalized_changes:
        normalized_changes["display_name"] = _required_text(
            normalized_changes["display_name"], message="显示名称不能为空"
        )
    if "is_active" in normalized_changes:
        normalized_changes["is_active"] = _required_bool(
            normalized_changes["is_active"], message="启用状态必须为布尔值"
        )
    if "phone" in normalized_changes:
        normalized_changes["phone"] = _optional_phone(normalized_changes["phone"])
        _check_phone_unique(
            session, normalized_changes["phone"], exclude_user_id=user.id
        )
    if "handover_user_id" in normalized_changes and normalized_changes["handover_user_id"] is not None:
        _validate_handover_target(session, user.id, normalized_changes["handover_user_id"])
    if "handover_note" in normalized_changes and normalized_changes["handover_note"] is not None:
        normalized_changes["handover_note"] = _required_text(
            normalized_changes["handover_note"], message="交接说明不能为空"
        )
    deactivating = normalized_changes.get("is_active") is False and user.is_active
    active_orders = []
    if deactivating:
        active_orders = session.scalars(
            select(Order).where(
                Order.owner_id == user.id,
                Order.status == OrderStatus.ACTIVE.value,
            )
        ).all()
        has_handover = normalized_changes.get("handover_user_id") is not None
        has_retention_note = bool(normalized_changes.get("handover_note"))
        if active_orders and not has_handover and not has_retention_note:
            raise Validation(
                "停用前必须转交或明确保留进行中订单",
                details={"active_order_count": len(active_orders)},
            )
    before = _user_snapshot(user)
    handover_target = normalized_changes.get("handover_user_id")
    if deactivating and handover_target is not None:
        for order in active_orders:
            order_before = {"owner_id": order.owner_id}
            order.owner_id = handover_target
            order.updated_by = actor
            session.flush()
            record_audit(
                session,
                action=AuditAction.USER_HANDOVER,
                entity_type="order",
                entity_id=order.id,
                actor=actor,
                before=order_before,
                after={"owner_id": order.owner_id, "handover_user_id": handover_target},
            )
    if deactivating:
        normalized_changes["deactivated_on"] = date.today()
    elif normalized_changes.get("is_active") is True:
        normalized_changes["deactivated_on"] = None
    for key, value in normalized_changes.items():
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
    if deactivating:
        record_audit(
            session,
            action=AuditAction.USER_DEACTIVATE,
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
    new_password = _required_password(new_password)
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
    password = _required_password(password)
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
    normalized_code = _required_text(code, message="团队编码不能为空").upper()
    normalized_name = _required_text(name, message="团队名称不能为空")
    if session.scalar(select(Team).where(Team.code == normalized_code)):
        raise Conflict("团队编码已存在")
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


__all__ = [
    "change_password",
    "create_team",
    "create_user",
    "revoke_token",
    "reset_password",
    "update_team",
    "update_user",
]
