"""微信登录通道：可切换实现（mock / openplatform）。

切换成本被压到「改环境变量」：调用方只认 `build_authorize_url` 与 `exchange_code`
两个函数，不关心底层是微信开放平台还是本地演示通道。

openplatform 走微信开放平台「网站应用」OAuth2：
  1. 跳转 https://open.weixin.qq.com/connect/qrconnect?...
  2. 用户扫码后回跳 `WECHAT_REDIRECT_URI?code=..&state=..`
  3. 服务端用 code 换 access_token + openid，再拉 userinfo
注意：**回调域名必须在微信开放平台备案**，微信不接受 IP 地址；这也是「凭据到位
之前只能先用 mock」的根本原因。
"""
from __future__ import annotations

import json
import secrets
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

from app.core.errors import Validation
from app.core.settings import Settings

MOCK = "mock"
OPEN_PLATFORM = "openplatform"

_PROVIDER_CODE = {MOCK: "MOCK", OPEN_PLATFORM: "OPEN_PLATFORM"}

_QR_CONNECT = "https://open.weixin.qq.com/connect/qrconnect"
_TOKEN_URL = "https://api.weixin.qq.com/sns/oauth2/access_token"
_USERINFO_URL = "https://api.weixin.qq.com/sns/userinfo"

_HTTP_TIMEOUT = 8


@dataclass(frozen=True)
class WeChatIdentity:
    """一次微信授权换回的身份。不含手机号——网站应用拿不到微信绑定手机号。"""

    provider: str  # 落库用的大写通道标识：MOCK / OPEN_PLATFORM
    open_id: str
    union_id: str | None = None
    nickname: str | None = None
    avatar_url: str | None = None


def provider_code(settings: Settings) -> str:
    return _PROVIDER_CODE.get(settings.wechat_provider, "MOCK")


def build_authorize_url(settings: Settings, *, state: str, redirect_uri: str) -> str:
    ready, reason = settings.wechat_ready
    if not ready:
        raise Validation(reason or "微信登录未启用")

    if settings.wechat_provider == MOCK:
        # 本地演示：直接回跳自身页面并附一个假 code，走与真实通道完全相同的后续流程。
        query = urllib.parse.urlencode({"code": f"mock-{secrets.token_hex(6)}", "state": state})
        separator = "&" if urllib.parse.urlparse(redirect_uri).query else "?"
        return f"{redirect_uri}{separator}{query}"

    query = urllib.parse.urlencode(
        {
            "appid": settings.wechat_app_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "snsapi_login",
            "state": state,
        }
    )
    return f"{_QR_CONNECT}?{query}#wechat_redirect"


def exchange_code(settings: Settings, *, code: str, redirect_uri: str = "") -> WeChatIdentity:
    """用授权 code 换身份。失败一律抛 422，不把微信原始错误码透给前端。"""
    if not code or not code.strip():
        raise Validation("缺少微信授权码，请重新发起登录")

    if settings.wechat_provider == MOCK:
        # 演示身份必须**稳定**：open_id 由随机 code 派生的话，每次扫码都是一张新「微信」，
        # 「绑定一次、之后免验证码」这条主路径永远走不到，演示价值为零。
        # 真实通道里 code 一次性、openid 恒定，mock 用固定值才对得上语义。
        return WeChatIdentity(
            provider=_PROVIDER_CODE[MOCK],
            open_id=settings.wechat_mock_open_id or "mock_demo_openid",
            nickname="微信演示用户",
        )

    token_data = _get_json(
        _TOKEN_URL,
        {
            "appid": settings.wechat_app_id,
            "secret": settings.wechat_app_secret,
            "code": code.strip(),
            "grant_type": "authorization_code",
        },
    )
    open_id = str(token_data.get("openid") or "").strip()
    access_token = str(token_data.get("access_token") or "").strip()
    if not open_id or not access_token:
        raise Validation("微信授权失败，请重试")

    union_id = str(token_data.get("unionid") or "").strip() or None
    nickname: str | None = None
    avatar_url: str | None = None
    # userinfo 是「锦上添花」：拉不到也不该让登录失败（微信偶发 48001 未授权）。
    try:
        info = _get_json(
            _USERINFO_URL,
            {"access_token": access_token, "openid": open_id, "lang": "zh_CN"},
        )
        nickname = str(info.get("nickname") or "").strip() or None
        avatar_url = str(info.get("headimgurl") or "").strip() or None
        union_id = union_id or (str(info.get("unionid") or "").strip() or None)
    except Validation:
        pass

    return WeChatIdentity(
        provider=_PROVIDER_CODE[OPEN_PLATFORM],
        open_id=open_id,
        union_id=union_id,
        nickname=nickname,
        avatar_url=avatar_url,
    )


def _get_json(url: str, params: dict[str, str]) -> dict:
    full = f"{url}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(full, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise Validation("微信服务暂时不可达，请稍后重试") from error
    try:
        data = json.loads(raw)
    except (ValueError, TypeError) as error:
        raise Validation("微信返回内容无法解析，请重试") from error
    if not isinstance(data, dict):
        raise Validation("微信返回内容无法解析，请重试")
    if data.get("errcode"):
        # 不把 errcode 原文抛给用户（含 appid 等上下文），只记在服务端日志由调用方处理。
        raise Validation("微信授权失败，请重试")
    return data


__all__ = [
    "MOCK",
    "OPEN_PLATFORM",
    "WeChatIdentity",
    "build_authorize_url",
    "exchange_code",
    "provider_code",
]
