"""无状态验证码：签发 / 校验（不落库）。

为什么不用验证码表（2026-11-05 用户裁决「验证码表不要」）：
验证码是一次性、短时效的东西，落库会带来「清理过期行、跨库同步、备份噪声」三类长期成本。
这里改用**服务端签名票据**：
  ticket = base64(payload) + "." + HMAC(secret, base64(payload))
  payload = {purpose, phone, chk, exp, jti}
其中 chk = HMAC(secret, purpose:phone:code)。前端拿着 ticket + 用户输入的明文验证码回来，
服务端只需按同一算法重算 chk 比对。

安全性：攻击者即使拿到 ticket，想从 chk 反推 6 位验证码必须对 10^6 个候选逐个做
HMAC——而 HMAC 的密钥在服务端，没有密钥无法离线穷举（这与「把明文验证码哈希后放进
票据」有本质区别，后者可离线爆破）。票据本身有 TTL 且绑定手机号，不能跨号复用。
局限：无状态的代价是不能在服务端累计「输错次数」，故在路由层按手机号 + IP 做限流
（见 auth/wechat_router.py），错误次数超限即在窗口内拒绝。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import time

from app.core.errors import Validation
from app.core.settings import Settings

PHONE_LOGIN = "PHONE_LOGIN"
WECHAT_BIND = "WECHAT_BIND"

# 中国大陆手机号：11 位，1 开头，第二位 3-9。
_PHONE_RE = re.compile(r"^1[3-9]\d{9}$")

_TOKEN_SEPARATOR = "."


def normalize_phone(raw: object) -> str:
    """归一化手机号：去空格/连字符/括号，去掉 +86 前缀。

    用户从通讯录复制的号码常带 `+86 138-0000-0000` 这类分隔符；不归一化会
    导致「后台明明配了这个手机号，登录却说未配置」——这种错最难排查。
    """
    text = "" if raw is None else str(raw)
    compact = re.sub(r"[\s\-()]", "", text)
    if compact.startswith("+86"):
        compact = compact[3:]
    elif compact.startswith("0086"):
        compact = compact[4:]
    elif compact.startswith("86") and len(compact) == 13:
        compact = compact[2:]
    return compact


def assert_valid_phone(phone: str) -> None:
    if not _PHONE_RE.match(phone):
        raise Validation("请输入正确的 11 位手机号")


def mask_phone(phone: str) -> str:
    """日志与提示用：保留前 3 后 4。"""
    if len(phone) < 8:
        return "***"
    return f"{phone[:3]}****{phone[-4:]}"


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def _sign(settings: Settings, message: str) -> str:
    return _b64e(
        hmac.new(settings.jwt_secret_key.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).digest()
    )


def _code_digest(settings: Settings, *, purpose: str, phone: str, code: str) -> str:
    message = f"{purpose}:{phone}:{code}"
    return hmac.new(
        settings.jwt_secret_key.encode("utf-8"), message.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def issue_ticket(settings: Settings, *, purpose: str, phone: str, ttl_seconds: int, **extra: object) -> str:
    """签发一个签名载荷（验证码票据 / 微信绑定票据共用）。

    `extra` 里的字段会原样放进载荷，调用方可附带 open_id 等上下文。
    """
    payload = {
        **extra,
        "purpose": purpose,
        "phone": phone,
        "exp": int(time.time()) + max(1, int(ttl_seconds)),
        "jti": secrets.token_hex(8),
    }
    body = _b64e(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    return f"{body}{_TOKEN_SEPARATOR}{_sign(settings, body)}"


def read_ticket(settings: Settings, token: str, *, purpose: str) -> dict:
    """校验签名与有效期，返回载荷。任何异常统一转成 422 文案。"""
    if not isinstance(token, str) or token.count(_TOKEN_SEPARATOR) != 1:
        raise Validation("凭证格式无效，请重新获取")
    body, signature = token.split(_TOKEN_SEPARATOR, 1)
    if not hmac.compare_digest(_sign(settings, body), signature):
        raise Validation("凭证校验失败，请重新获取")
    try:
        payload = json.loads(_b64d(body))
    except (ValueError, TypeError) as error:
        raise Validation("凭证无法解析，请重新获取") from error
    if not isinstance(payload, dict):
        raise Validation("凭证内容无效，请重新获取")
    if payload.get("purpose") != purpose:
        raise Validation("凭证用途不匹配，请重新获取")
    if int(payload.get("exp", 0)) < int(time.time()):
        raise Validation("验证码已过期，请重新获取")
    return payload


def issue_code(
    settings: Settings, *, purpose: str, phone: str
) -> tuple[str, str, int]:
    """生成验证码并封装成票据。返回 (ticket, 明文验证码, 有效期秒数)。

    明文验证码只交给短信通道与（mock 模式下的）响应体，绝不落库、绝不进日志正文。
    """
    code = f"{secrets.randbelow(1_000_000):06d}"
    ttl = max(30, int(settings.sms_code_ttl_seconds))
    ticket = issue_ticket(
        settings,
        purpose=purpose,
        phone=phone,
        ttl_seconds=ttl,
        chk=_code_digest(settings, purpose=purpose, phone=phone, code=code),
    )
    return ticket, code, ttl


def verify_code(settings: Settings, *, ticket: str, purpose: str, phone: str, code: str) -> None:
    """校验票据与验证码。不一致只给一句统一文案，不区分「票错了」还是「码错了」。"""
    payload = read_ticket(settings, ticket, purpose=purpose)
    if payload.get("phone") != phone:
        # 票据与手机号必须严格一致：否则拿到 A 的票据配上 B 的号就能绕过。
        raise Validation("手机号与验证码不匹配，请重新获取")
    expected = _code_digest(settings, purpose=purpose, phone=phone, code=str(code).strip())
    if not hmac.compare_digest(str(payload.get("chk", "")), expected):
        raise Validation("验证码错误或已失效")


__all__ = [
    "PHONE_LOGIN",
    "WECHAT_BIND",
    "assert_valid_phone",
    "issue_code",
    "issue_ticket",
    "mask_phone",
    "normalize_phone",
    "read_ticket",
    "verify_code",
]
