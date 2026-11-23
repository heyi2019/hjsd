"""auth.session：当前用户解析与数据范围（owner scope）判定——需查库的部分。

2026-11-18 架构归位：`core/security.py` 原先同时承担两件事——
1. 纯技术能力：角色/权限常量、`CurrentUser` 数据类、令牌载荷校验、依赖工厂；
2. 需查库的能力：按令牌取当前用户、按负责人范围过滤记录。

第 2 类依赖 ORM（`User` / `RevokedToken`），留在 core 层会造成
`core → domain` 的反向边（core ↔ domain 环）。故上移到 auth 域：
认证本就是业务域，`app/auth` 已有 router 与 service，归属自然。

**口径不变**：可见性判定仍是 owner_scope + is_admin + TEAM 成员关系，
与迁移前逐字一致。
"""
from __future__ import annotations

import hmac

from fastapi import Depends, Header, Request
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import AuthError, ErrorCode, PermissionDenied
from app.core.security import (
    DEV_USERS,
    CurrentUser,
    user_from_payload,
)
from app.core.settings import Settings, get_settings
from app.core.tokens import credential_stamp, decode_token
from app.domain.users import RevokedToken, User
from app.shared.scope import owner_scope_filter, owner_scope_ids


def get_current_user(
    request: Request,
    authorization: str | None = Header(default=None, alias="Authorization"),
    x_dev_user: str | None = Header(default=None, alias="X-Dev-User"),
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
) -> CurrentUser:
    """解析当前登录用户；无凭证返回 401 `AUTH_REQUIRED`。"""
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise AuthError("登录凭证格式无效")
        payload = decode_token(token, settings=settings)
        jti = payload.get("jti")
        if jti is not None and (not isinstance(jti, str) or not jti.strip()):
            raise AuthError("登录凭证内容无效")
        if jti and db.get(RevokedToken, jti):
            raise AuthError("登录已退出，请重新登录")
        try:
            user_id = int(payload.get("sub", 0))
        except (TypeError, ValueError) as error:
            raise AuthError("登录凭证内容无效") from error
        account = db.get(User, user_id)
        if account is not None and account.username == payload.get("username"):
            if not account.is_active:
                raise AuthError("账号已停用，请联系管理员")
            stamp = payload.get("credential_stamp")
            if (stamp is None and not settings.is_development) or (
                stamp is not None and (not isinstance(stamp, str) or not stamp.isascii() or not hmac.compare_digest(stamp, credential_stamp(account.password_hash, settings=settings)))
            ):
                raise AuthError("登录凭证已失效，请重新登录", code=ErrorCode.SESSION_INVALIDATED)
            permitted_paths = {f"{settings.api_prefix}/auth/me", f"{settings.api_prefix}/auth/change-password"}
            if account.must_change_password and request.url.path not in permitted_paths:
                raise PermissionDenied("请先修改初始密码", code=ErrorCode.PASSWORD_CHANGE_REQUIRED)
            # JWT 只证明 token 曾由服务签发；角色、数据范围和池授权以当前
            # 数据库记录为准，使停用/改权在旧 token 未过期时也立即生效。
            return CurrentUser.build(
                id=account.id,
                username=account.username,
                display_name=account.display_name,
                roles=[account.role],
                pool_ids=frozenset(account.pool_ids or []),
                team_ids=frozenset(account.team_ids or []),
                owner_scope=account.owner_scope,
            )
        if settings.is_development:
            # 开发/测试环境允许用签名 token 模拟尚未落库的角色，便于权限链路验证。
            return user_from_payload(payload)
        raise AuthError("登录账号不存在或凭证已失效")

    if settings.is_development and x_dev_user:
        user = DEV_USERS.get(x_dev_user.strip().lower())
        if user is None:
            raise AuthError(f"未知的开发态用户 {x_dev_user}")
        return user

    raise AuthError("未登录或凭证已失效")


def require_permissions(*codes: str, require_all: bool = True):
    """权限依赖工厂：`user: CurrentUser = Depends(require_permissions("pool.manage"))`。"""

    def dependency(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        missing = [code for code in codes if not user.has(code)]
        should_fail = missing if require_all else len(missing) == len(codes)
        if should_fail:
            raise PermissionDenied(
                "当前角色无权执行该操作",
                details={"required": list(codes), "missing": missing},
            )
        return user

    return Depends(dependency)


def require_role(*roles: str):
    """角色依赖工厂：只要命中任一角色即通过。"""

    def dependency(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if not any(role in user.roles for role in roles):
            raise PermissionDenied(
                "当前角色无权访问该资源", details={"required_roles": list(roles)}
            )
        return user

    return Depends(dependency)


__all__ = [
    "get_current_user",
    "owner_scope_filter",
    "owner_scope_ids",
    "require_permissions",
    "require_role",
]
