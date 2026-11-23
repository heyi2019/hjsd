"""JWT 签发校验与密码摘要。"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from typing import Any, TYPE_CHECKING

from app.core.errors import AuthError, TokenExpired
from app.core.settings import Settings, get_settings

if TYPE_CHECKING:
    from app.core.security import CurrentUser


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
    """签发 HS256 JWT。"""
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
    """校验签名与有效期；失败抛 401。"""
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


def credential_stamp(password_hash: str, *, settings: Settings | None = None) -> str:
    """将令牌绑定当前密码摘要；令牌中不暴露密码或密码摘要。"""
    settings = settings or get_settings()
    return hmac.new(settings.jwt_secret_key.encode(), f"erp:credential:{password_hash}".encode(), hashlib.sha256).hexdigest()


def build_access_token(user: CurrentUser, *, password_hash: str | None = None, settings: Settings | None = None) -> str:
    """把用户会话关键信息打包进 token，不写入手机号等敏感资料。"""
    return encode_token(
        {
            "sub": str(user.id),
            "jti": uuid.uuid4().hex,
            "username": user.username,
            "roles": list(user.roles),
            "pool_ids": sorted(user.pool_ids),
            "team_ids": sorted(user.team_ids),
            "owner_scope": user.owner_scope,
            **({"credential_stamp": credential_stamp(password_hash, settings=settings)} if password_hash is not None else {}),
        },
        settings=settings,
    )


__all__ = [
    "_b64url_decode",
    "_b64url_encode",
    "_sign",
    "build_access_token",
    "decode_token",
    "encode_token",
    "hash_password",
    "verify_password",
]
