"""core.security：认证、角色权限点、权限依赖（BAS-05-01）。

两级授权：**角色权限 + 数据范围**（权限矩阵 §1）。接口必须二次鉴权，
前端隐藏菜单不构成权限控制。查看者直接调用写接口返回 `403 PERMISSION_DENIED`。

JWT 用标准库（hmac/hashlib）实现 HS256，避免为 MVP 引入额外依赖。
开发/测试环境允许 `X-Dev-User` 直通，生产环境一律拒绝。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from fastapi import Depends, Header

from app.core.errors import AuthError, PermissionDenied, TokenExpired
from app.core.settings import Settings, get_settings

# ------------------------------------------------------------------ 角色与权限点
ROLE_ADMIN = "ADMIN"
ROLE_OPERATOR = "OPERATOR"
ROLE_FINANCE = "FINANCE"
ROLE_AUDITOR = "AUDITOR"
ROLE_VIEWER = "VIEWER"

ALL_ROLES: tuple[str, ...] = (ROLE_ADMIN, ROLE_OPERATOR, ROLE_FINANCE, ROLE_AUDITOR, ROLE_VIEWER)

PERM_CUSTOMER_READ = "customer.read"
PERM_CUSTOMER_CONTACT_READ = "customer.contact.read"
PERM_CUSTOMER_CREATE = "customer.create"
PERM_CUSTOMER_UPDATE = "customer.update"
PERM_CUSTOMER_CONTACT_WRITE = "customer.contact.write"
PERM_CUSTOMER_MERGE = "customer.merge"
PERM_COUNTERPARTY_READ = "counterparty.read"
PERM_COUNTERPARTY_MANAGE = "counterparty.manage"
PERM_ORDER_CREATE = "order.create"
PERM_ORDER_UPDATE = "order.update"
PERM_ORDER_EVENT_POST = "order.event.post"
PERM_ORDER_EXCEPTION_APPROVE = "order.exception.approve"
PERM_FINANCE_READ = "finance.read"
PERM_FINANCE_TRANSFER = "finance.transfer"
PERM_DEPOSIT_POST = "deposit.post"
PERM_POLICY_MANAGE = "policy.manage"
PERM_POLICY_APPROVE = "policy.approve"
PERM_FIELD_DEFINITION_MANAGE = "field-definition.manage"
PERM_AUDIT_READ = "audit.read"
PERM_POOL_MANAGE = "pool.manage"
PERM_ORDER_TYPE_MANAGE = "order-type.manage"
PERM_QUALITY_READ = "quality.read"
PERM_QUALITY_RESOLVE = "quality.resolve"
PERM_REPORT_READ = "report.read"
PERM_HISTORY_IMPORT = "history.import"

ALL_PERMISSIONS: frozenset[str] = frozenset(
    {
        PERM_CUSTOMER_READ,
        PERM_CUSTOMER_CONTACT_READ,
        PERM_CUSTOMER_CREATE,
        PERM_CUSTOMER_UPDATE,
        PERM_CUSTOMER_CONTACT_WRITE,
        PERM_CUSTOMER_MERGE,
        PERM_COUNTERPARTY_READ,
        PERM_COUNTERPARTY_MANAGE,
        PERM_ORDER_CREATE,
        PERM_ORDER_UPDATE,
        PERM_ORDER_EVENT_POST,
        PERM_ORDER_EXCEPTION_APPROVE,
        PERM_FINANCE_READ,
        PERM_FINANCE_TRANSFER,
        PERM_DEPOSIT_POST,
        PERM_POLICY_MANAGE,
        PERM_POLICY_APPROVE,
        PERM_FIELD_DEFINITION_MANAGE,
        PERM_AUDIT_READ,
        PERM_POOL_MANAGE,
        PERM_ORDER_TYPE_MANAGE,
        PERM_QUALITY_READ,
        PERM_QUALITY_RESOLVE,
        PERM_REPORT_READ,
        PERM_HISTORY_IMPORT,
    }
)

ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    ROLE_ADMIN: ALL_PERMISSIONS,
    ROLE_OPERATOR: frozenset(
        {
            PERM_CUSTOMER_READ,
            PERM_CUSTOMER_CONTACT_READ,
            PERM_CUSTOMER_CREATE,
            PERM_CUSTOMER_UPDATE,
            PERM_CUSTOMER_CONTACT_WRITE,
            PERM_COUNTERPARTY_READ,
            PERM_ORDER_CREATE,
            PERM_ORDER_UPDATE,
            PERM_ORDER_EVENT_POST,
            PERM_FINANCE_READ,
            PERM_QUALITY_READ,
            PERM_REPORT_READ,
        }
    ),
    ROLE_FINANCE: frozenset(
        {
            PERM_CUSTOMER_READ,
            PERM_CUSTOMER_CONTACT_READ,
            PERM_COUNTERPARTY_READ,
            PERM_FINANCE_READ,
            PERM_FINANCE_TRANSFER,
            PERM_DEPOSIT_POST,
            PERM_AUDIT_READ,
            PERM_QUALITY_READ,
            PERM_REPORT_READ,
        }
    ),
    ROLE_AUDITOR: frozenset(
        {
            PERM_CUSTOMER_READ,
            PERM_CUSTOMER_CONTACT_READ,
            PERM_COUNTERPARTY_READ,
            PERM_FINANCE_READ,
            PERM_ORDER_EXCEPTION_APPROVE,
            PERM_POLICY_MANAGE,
            PERM_POLICY_APPROVE,
            PERM_AUDIT_READ,
            PERM_QUALITY_READ,
            PERM_QUALITY_RESOLVE,
            PERM_REPORT_READ,
        }
    ),
    ROLE_VIEWER: frozenset({PERM_FINANCE_READ, PERM_QUALITY_READ, PERM_REPORT_READ}),
}


@dataclass(frozen=True)
class CurrentUser:
    """登录上下文：角色决定动作，数据范围决定可见对象。"""

    id: int
    username: str
    display_name: str = ""
    roles: tuple[str, ...] = ()
    permissions: frozenset[str] = field(default_factory=frozenset)
    pool_ids: frozenset[int] = frozenset()  # 空集表示“无池授权”，明细接口应返回空
    team_ids: frozenset[int] = frozenset()
    owner_scope: str = "SELF"  # SELF / TEAM / ALL

    @classmethod
    def build(cls, *, id: int, username: str, roles: Iterable[str], **kwargs: Any) -> "CurrentUser":
        role_tuple = tuple(role for role in roles if role in ALL_ROLES)
        permissions: frozenset[str] = frozenset()
        for role in role_tuple:
            permissions |= ROLE_PERMISSIONS.get(role, frozenset())
        return cls(id=id, username=username, roles=role_tuple, permissions=permissions, **kwargs)

    @property
    def is_admin(self) -> bool:
        return ROLE_ADMIN in self.roles

    def has(self, code: str) -> bool:
        return code in self.permissions

    def has_all(self, codes: Sequence[str]) -> bool:
        return all(code in self.permissions for code in codes)

    def has_any(self, codes: Sequence[str]) -> bool:
        return any(code in self.permissions for code in codes)

    def can_see_pool(self, pool_id: int) -> bool:
        """空授权集合视为无权限；管理员不受池范围限制。"""
        if self.is_admin or self.owner_scope == "ALL":
            return True
        return pool_id in self.pool_ids


# ------------------------------------------------------------------ JWT（stdlib）
def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _sign(signing_input: str, secret: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), signing_input.encode("utf-8"), hashlib.sha256)
    return _b64url_encode(digest.digest())


def encode_token(
    payload: dict[str, Any],
    *,
    expires_minutes: int | None = None,
    settings: Settings | None = None,
) -> str:
    """签发 HS256 JWT。

    `expires_minutes` <= 0 会生成已过期 token，供过期链路测试使用。
    """
    settings = settings or get_settings()
    issued_at = int(time.time())
    ttl = int(settings.access_token_expire_minutes) if expires_minutes is None else int(expires_minutes)
    body = {**payload, "iat": issued_at, "exp": issued_at + ttl * 60}
    header = {"alg": settings.jwt_algorithm, "typ": "JWT"}
    signing_input = ".".join(
        [
            _b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8")),
            _b64url_encode(json.dumps(body, separators=(",", ":")).encode("utf-8")),
        ]
    )
    return f"{signing_input}.{_sign(signing_input, settings.jwt_secret_key)}"


def decode_token(token: str, *, settings: Settings | None = None) -> dict[str, Any]:
    """校验签名与有效期；失败抛 401（`AUTH_REQUIRED` / `TOKEN_EXPIRED`）。"""
    settings = settings or get_settings()
    parts = token.split(".")
    if len(parts) != 3:
        raise AuthError("登录凭证格式无效")
    signing_input = f"{parts[0]}.{parts[1]}"
    expected = _sign(signing_input, settings.jwt_secret_key)
    if not hmac.compare_digest(expected, parts[2]):
        raise AuthError("登录凭证校验失败")
    try:
        header = json.loads(_b64url_decode(parts[0]))
        payload = json.loads(_b64url_decode(parts[1]))
    except (ValueError, TypeError) as error:
        raise AuthError("登录凭证无法解析") from error
    if header.get("alg") != settings.jwt_algorithm:
        raise AuthError("登录凭证算法不被接受")
    if int(payload.get("exp", 0)) < int(time.time()):
        raise TokenExpired("登录已过期，请重新登录")
    return payload


def build_access_token(user: "CurrentUser", *, settings: Settings | None = None) -> str:
    """把 CurrentUser 的关键信息打包进 token（不写入手机号等敏感资料）。"""
    return encode_token(
        {
            "sub": str(user.id),
            "username": user.username,
            "roles": list(user.roles),
            "pool_ids": sorted(user.pool_ids),
            "team_ids": sorted(user.team_ids),
            "owner_scope": user.owner_scope,
        },
        settings=settings,
    )


def user_from_payload(payload: dict[str, Any]) -> CurrentUser:
    return CurrentUser.build(
        id=int(payload.get("sub", 0)),
        username=payload.get("username", "unknown"),
        roles=payload.get("roles", []),
        display_name=payload.get("display_name", payload.get("username", "unknown")),
        pool_ids=frozenset(payload.get("pool_ids", [])),
        team_ids=frozenset(payload.get("team_ids", [])),
        owner_scope=payload.get("owner_scope", "SELF"),
    )


# ------------------------------------------------------------------ 依赖注入
DEV_USERS: dict[str, CurrentUser] = {
    "admin": CurrentUser.build(
        id=1, username="admin", roles=[ROLE_ADMIN], display_name="系统管理员", owner_scope="ALL"
    ),
    "operator": CurrentUser.build(
        id=2, username="operator", roles=[ROLE_OPERATOR], display_name="业务经办人"
    ),
    "finance": CurrentUser.build(
        id=3, username="finance", roles=[ROLE_FINANCE], display_name="财务"
    ),
    "auditor": CurrentUser.build(id=4, username="auditor", roles=[ROLE_AUDITOR], display_name="审核人"),
    "viewer": CurrentUser.build(id=5, username="viewer", roles=[ROLE_VIEWER], display_name="经营查看人"),
}


def get_current_user(
    authorization: str | None = Header(default=None, alias="Authorization"),
    x_dev_user: str | None = Header(default=None, alias="X-Dev-User"),
    settings: Settings = Depends(get_settings),
) -> CurrentUser:
    """解析当前登录用户；无凭证返回 401 `AUTH_REQUIRED`。"""
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise AuthError("登录凭证格式无效")
        return user_from_payload(decode_token(token, settings=settings))

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
            raise PermissionDenied("当前角色无权访问该资源", details={"required_roles": list(roles)})
        return user

    return Depends(dependency)


__all__ = [
    "ALL_PERMISSIONS",
    "ALL_ROLES",
    "DEV_USERS",
    "CurrentUser",
    "ROLE_ADMIN",
    "ROLE_AUDITOR",
    "ROLE_FINANCE",
    "ROLE_OPERATOR",
    "ROLE_PERMISSIONS",
    "ROLE_VIEWER",
    "build_access_token",
    "decode_token",
    "encode_token",
    "get_current_user",
    "require_permissions",
    "require_role",
    "user_from_payload",
]
