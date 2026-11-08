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
import os
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from fastapi import Depends, Header
from sqlalchemy.sql.elements import ColumnElement
from sqlalchemy.orm import Session

from app.core.errors import AuthError, PermissionDenied, TokenExpired
from app.core.database import get_db
from app.core.settings import Settings, get_settings
from app.domain.users import RevokedToken, User

# ------------------------------------------------------------------ 角色与权限点
ROLE_ADMIN = "ADMIN"
ROLE_OPERATOR = "OPERATOR"
ROLE_FINANCE = "FINANCE"
ROLE_AUDITOR = "AUDITOR"
ROLE_VIEWER = "VIEWER"
ROLE_EMPLOYEE = "EMPLOYEE"

ALL_ROLES: tuple[str, ...] = (ROLE_ADMIN, ROLE_OPERATOR, ROLE_FINANCE, ROLE_AUDITOR, ROLE_VIEWER, ROLE_EMPLOYEE)
OWNER_SCOPES: frozenset[str] = frozenset({"SELF", "TEAM", "ALL"})

# 认证方式（写进 token 的 amr 声明）。免密登录进来的会话从未输入过密码，
# 改密时的「当前密码」校验需要据此区分，否则首次登录会死锁。
AUTH_METHOD_PASSWORD = "password"
AUTH_METHOD_PHONE = "phone_code"
AUTH_METHOD_WECHAT = "wechat"
AUTH_METHODS: frozenset[str] = frozenset({AUTH_METHOD_PASSWORD, AUTH_METHOD_PHONE, AUTH_METHOD_WECHAT})

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
PERM_FINANCE_ORDER_EVENT_POST = "finance.order.event.post"
PERM_FINANCE_READ = "finance.read"
PERM_DEPOSIT_POST = "deposit.post"
PERM_TRANSFER_POST = "finance.transfer"
PERM_POLICY_MANAGE = "policy.manage"
PERM_FIELD_DEFINITION_MANAGE = "field-definition.manage"
PERM_AUDIT_READ = "audit.read"
PERM_POOL_MANAGE = "pool.manage"
PERM_ORDER_TYPE_MANAGE = "order-type.manage"
PERM_REPORT_READ = "report.read"
PERM_REPORT_EXPORT = "report.export"
PERM_USER_MANAGE = "user.manage"
PERM_OPTION_SET_MANAGE = "option-set.manage"

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
        PERM_FINANCE_ORDER_EVENT_POST,
        PERM_FINANCE_READ,
        PERM_DEPOSIT_POST,
        PERM_TRANSFER_POST,
        PERM_POLICY_MANAGE,
        PERM_FIELD_DEFINITION_MANAGE,
        PERM_AUDIT_READ,
        PERM_POOL_MANAGE,
        PERM_ORDER_TYPE_MANAGE,
        PERM_REPORT_READ,
        PERM_REPORT_EXPORT,
        PERM_USER_MANAGE,
        PERM_OPTION_SET_MANAGE,
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
            PERM_REPORT_READ,
            PERM_REPORT_EXPORT,
        }
    ),
    ROLE_FINANCE: frozenset(
        {
            PERM_CUSTOMER_READ,
            PERM_CUSTOMER_CONTACT_READ,
            PERM_COUNTERPARTY_READ,
            PERM_FINANCE_READ,
            PERM_DEPOSIT_POST,
            PERM_TRANSFER_POST,
            PERM_FINANCE_ORDER_EVENT_POST,
            PERM_AUDIT_READ,
            PERM_REPORT_READ,
            PERM_REPORT_EXPORT,
        }
    ),
    ROLE_AUDITOR: frozenset(
        {
            PERM_CUSTOMER_READ,
            PERM_CUSTOMER_CONTACT_READ,
            PERM_COUNTERPARTY_READ,
            PERM_FINANCE_READ,
            PERM_POLICY_MANAGE,
            PERM_AUDIT_READ,
            PERM_REPORT_READ,
            PERM_REPORT_EXPORT,
        }
    ),
    ROLE_VIEWER: frozenset({PERM_FINANCE_READ, PERM_REPORT_READ}),
    # 普通员工：仅业务录入（建单 + 读客户/合作方），不含 finance.read / report.read
    # 及任何管理类权限——经营中心、资金中心对其隐藏（前端导航按权限收口）。
    ROLE_EMPLOYEE: frozenset(
        {
            PERM_ORDER_CREATE,
            PERM_CUSTOMER_READ,
            PERM_COUNTERPARTY_READ,
        }
    ),
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
    # 本次会话的认证方式；缺少 amr 时按 password 处理。
    auth_method: str = AUTH_METHOD_PASSWORD

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

    @property
    def password_authenticated(self) -> bool:
        """本次会话是否由「账号密码」建立——只有这种会话能证明用户知道旧密码。"""
        return self.auth_method == AUTH_METHOD_PASSWORD

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

    def can_see_owner(self, owner_id: int | None) -> bool:
        """Fast-path check for owner-scoped records; TEAM needs a DB-aware helper."""
        if self.is_admin or self.owner_scope == "ALL":
            return True
        return owner_id == self.id


def owner_scope_ids(session: Any, user: CurrentUser) -> set[int] | None:
    """Resolve the owner ids visible to a user, including TEAM membership.

    Team membership is intentionally resolved in Python for now: the membership
    list is stored as JSON during this incremental rollout. Cache the result on
    the request session because one endpoint commonly builds several scoped
    queries for the same user.
    """
    if user.is_admin or user.owner_scope == "ALL":
        return None
    if user.owner_scope != "TEAM" or not user.team_ids:
        return {user.id}
    from app.domain.users import User

    scope_cache = getattr(session, "info", {}).setdefault("_owner_scope_ids", {})
    cache_key = (user.id, user.owner_scope, tuple(sorted(user.team_ids)))
    cached = scope_cache.get(cache_key)
    if cached is not None:
        return set(cached)
    visible = {user.id}
    for owner_id, team_ids in session.query(User.id, User.team_ids).all():
        if set(team_ids or []).intersection(user.team_ids):
            visible.add(owner_id)
    scope_cache[cache_key] = frozenset(visible)
    return visible


def owner_scope_filter(column: ColumnElement, user: CurrentUser, session: Any | None = None) -> ColumnElement | None:
    """Return a SQL predicate for owner-scoped tables; None means unrestricted."""
    ids = owner_scope_ids(session, user) if session is not None else None
    if ids is None and (user.is_admin or user.owner_scope == "ALL"):
        return None
    return column.in_(ids or {user.id})


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
    if not isinstance(header, dict) or not isinstance(payload, dict):
        raise AuthError("登录凭证内容无效")
    if header.get("alg") != settings.jwt_algorithm:
        raise AuthError("登录凭证算法不被接受")
    try:
        expires_at = int(payload.get("exp", 0))
    except (TypeError, ValueError) as error:
        raise AuthError("登录凭证内容无效") from error
    if expires_at < int(time.time()):
        raise TokenExpired("登录已过期，请重新登录")
    return payload


def hash_password(password: str) -> str:
    """Hash a password with PBKDF2; the stored value contains its salt."""
    if len(password) < 8:
        raise ValueError("密码至少需要 8 位")
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 240_000)
    return f"pbkdf2_sha256$240000${_b64url_encode(salt)}${_b64url_encode(digest)}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, rounds, salt, digest = encoded.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), _b64url_decode(salt), int(rounds)
        )
        return hmac.compare_digest(candidate, _b64url_decode(digest))
    except (ValueError, TypeError):
        return False


def build_access_token(user: "CurrentUser", *, settings: Settings | None = None) -> str:
    """把 CurrentUser 的关键信息打包进 token（不写入手机号等敏感资料）。"""
    return encode_token(
        {
            "sub": str(user.id),
            "jti": uuid.uuid4().hex,
            "username": user.username,
            "roles": list(user.roles),
            "pool_ids": sorted(user.pool_ids),
            "team_ids": sorted(user.team_ids),
            "owner_scope": user.owner_scope,
            "amr": user.auth_method,
        },
        settings=settings,
    )


def user_from_payload(payload: dict[str, Any]) -> CurrentUser:
    try:
        raw_user_id = payload.get("sub", 0)
        if isinstance(raw_user_id, bool):
            raise ValueError("身份声明无效")
        user_id = int(raw_user_id)
        username = payload.get("username")
        roles = payload.get("roles", [])
        pool_ids = payload.get("pool_ids", [])
        team_ids = payload.get("team_ids", [])
        owner_scope = payload.get("owner_scope", "SELF")
        auth_method = payload.get("amr", AUTH_METHOD_PASSWORD)
        jti = payload.get("jti")
        if user_id <= 0 or not isinstance(username, str) or not username.strip():
            raise ValueError("身份声明无效")
        if not isinstance(roles, list) or not isinstance(pool_ids, list) or not isinstance(team_ids, list):
            raise ValueError("角色或范围集合格式无效")
        if any(not isinstance(role, str) or role not in ALL_ROLES for role in roles):
            raise ValueError("角色权限无效")
        if any(isinstance(item, bool) or not isinstance(item, int) or item <= 0 for item in pool_ids + team_ids):
            raise ValueError("数据范围(scope)无效")
        if not isinstance(owner_scope, str) or owner_scope not in OWNER_SCOPES:
            raise ValueError("归属范围无效")
        if not isinstance(auth_method, str) or auth_method not in AUTH_METHODS:
            raise ValueError("认证方式无效")
        display_name = payload.get("display_name", username.strip())
        if not isinstance(display_name, str) or not display_name.strip():
            raise ValueError("显示名称无效")
        if jti is not None and (not isinstance(jti, str) or not jti.strip()):
            raise ValueError("令牌标识(jti)无效")
    except (TypeError, ValueError) as error:
        raise AuthError("登录凭证内容无效") from error
    return CurrentUser.build(
        id=user_id,
        username=username.strip(),
        roles=roles,
        display_name=display_name.strip(),
        pool_ids=frozenset(pool_ids),
        team_ids=frozenset(team_ids),
        owner_scope=owner_scope,
        auth_method=auth_method,
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
    "employee": CurrentUser.build(id=6, username="employee", roles=[ROLE_EMPLOYEE], display_name="普通员工"),
}


def get_current_user(
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
        # 认证方式随 token 走，且必须在重建 CurrentUser 时带下去——否则免密登录的会话
        # 会被误判为密码会话，首次设置密码又回到死锁。
        auth_method = payload.get("amr", AUTH_METHOD_PASSWORD)
        if not isinstance(auth_method, str) or auth_method not in AUTH_METHODS:
            raise AuthError("登录凭证内容无效")
        try:
            user_id = int(payload.get("sub", 0))
        except (TypeError, ValueError) as error:
            raise AuthError("登录凭证内容无效") from error
        account = db.get(User, user_id)
        if account is not None and account.username == payload.get("username"):
            if not account.is_active:
                raise AuthError("账号已停用，请联系管理员")
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
                auth_method=auth_method,
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
            raise PermissionDenied("当前角色无权访问该资源", details={"required_roles": list(roles)})
        return user

    return Depends(dependency)


__all__ = [
    "ALL_PERMISSIONS",
    "ALL_ROLES",
    "AUTH_METHODS",
    "AUTH_METHOD_PASSWORD",
    "AUTH_METHOD_PHONE",
    "AUTH_METHOD_WECHAT",
    "DEV_USERS",
    "CurrentUser",
    "ROLE_ADMIN",
    "ROLE_AUDITOR",
    "ROLE_EMPLOYEE",
    "ROLE_FINANCE",
    "ROLE_OPERATOR",
    "ROLE_PERMISSIONS",
    "ROLE_VIEWER",
    "OWNER_SCOPES",
    "PERM_FINANCE_ORDER_EVENT_POST",
    "PERM_REPORT_EXPORT",
    "build_access_token",
    "decode_token",
    "encode_token",
    "get_current_user",
    "hash_password",
    "owner_scope_filter",
    "require_permissions",
    "require_role",
    "user_from_payload",
    "verify_password",
]
