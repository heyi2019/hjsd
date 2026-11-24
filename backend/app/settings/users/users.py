"""settings.users.users：登录账号与密码的写入（含停用时订单交接）。"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import AuthError, Conflict, Validation
from app.core.security import ALL_ROLES, OWNER_SCOPES, hash_password, verify_password
from app.domain.enums import AuditAction, OrderStatus
from app.domain.trade import Order
from app.domain.users import RevokedToken, User
from app.settings.users._validation import (
    _USER_MUTABLE_FIELDS,
    _check_phone_unique,
    _check_pool_ids,
    _check_team_ids,
    _optional_phone,
    _required_bool,
    _required_password,
    _required_text,
    _user_snapshot,
    _validate_handover_target,
    _validate_id_list,
)


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
    pool_ids = _validate_id_list(pool_ids, label="资金账户") or []
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
        changes = {**changes, "pool_ids": _validate_id_list(changes["pool_ids"], label="资金账户")}
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
                Order.status.in_([
                    OrderStatus.ACTIVE.value,
                    OrderStatus.INSTALLMENT.value,
                ]),
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
                entity_id=order.order_no,
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
    """改密必须校验当前密码。"""
    user = session.scalar(select(User).where(User.id == user_id).with_for_update().execution_options(populate_existing=True))
    if user is None:
        raise AuthError("原密码错误")
    if not verify_password(old_password, user.password_hash):
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
    user = session.scalar(select(User).where(User.id == user_id).with_for_update().execution_options(populate_existing=True))
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
