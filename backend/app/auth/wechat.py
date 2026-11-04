"""微信登录通道：可切换实现（扫码 / 公众号 H5），两种形态共用一套身份与绑定模型。

调用方只认四个函数：
  - 扫码（桌面）：`build_authorize_url` / `exchange_code`
  - H5（手机）：`build_h5_authorize_url` / `exchange_h5_code`
不关心底层是开放平台、公众号还是本地演示通道。

openplatform（桌面扫码）走微信开放平台「网站应用」OAuth2：
  1. 跳转 https://open.weixin.qq.com/connect/qrconnect?...
  2. 用户扫码后回跳 `WECHAT_REDIRECT_URI?code=..&state=..`
  3. 服务端用 code 换 access_token + openid，再拉 userinfo

mp（手机 H5）走公众号「网页授权」：
  1. 跳转 https://open.weixin.qq.com/connect/oauth2/authorize?...
  2. 用户在微信内确认后回跳 `WECHAT_H5_REDIRECT_URI?code=..&state=..`
  3. 同一套 sns/oauth2/access_token 与 sns/userinfo 拉身份
  必须**在微信内置浏览器里**发起：微信外的普通浏览器不支持网页授权。

注意：**回调域名必须已备案**（两个通道都一样），微信不接受 IP 地址；这也是
「凭据到位之前只能先用 mock」的根本原因。
另外同一自然人在「网站应用」与「公众号」下的 openid 并不相同，两者要在系统里
认成同一个人，须把两个应用绑到同一开放平台主体下（靠 unionid 归一）。
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
MP = "mp"

# 公众号与网站应用都落 OPEN_PLATFORM：绑定表 provider 列的 CHECK 只认
# ('MOCK','OPEN_PLATFORM')，加值要改表约束（当前迁移策略下不引入增量迁移）。
# 两者 openid 由各自 appid 派生、不会撞号，落同一枚举不影响唯一性。
_PROVIDER_CODE = {MOCK: "MOCK", OPEN_PLATFORM: "OPEN_PLATFORM", MP: "OPEN_PLATFORM"}

_QR_CONNECT = "https://open.weixin.qq.com/connect/qrconnect"
_OAUTH2_AUTHORIZE = "https://open.weixin.qq.com/connect/oauth2/authorize"
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


def build_h5_authorize_url(settings: Settings, *, state: str, redirect_uri: str) -> str:
    """公众号网页授权地址。必须在微信内置浏览器里打开，微信外无法完成授权。"""
    ready, reason = settings.wechat_h5_ready
    if not ready:
        raise Validation(reason or "微信 H5 登录未启用")

    if settings.wechat_h5_provider == MOCK:
        # 演示：与扫码通道完全同一套后续流程，只是把 code 直接回跳给自己。
        query = urllib.parse.urlencode({"code": f"mock-{secrets.token_hex(6)}", "state": state})
        separator = "&" if urllib.parse.urlparse(redirect_uri).query else "?"
        return f"{redirect_uri}{separator}{query}"

    query = urllib.parse.urlencode(
        {
            "appid": settings.wechat_h5_app_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "snsapi_userinfo",
            "state": state,
        }
    )
    return f"{_OAUTH2_AUTHORIZE}?{query}#wechat_redirect"


def exchange_code(settings: Settings, *, code: str, redirect_uri: str = "") -> WeChatIdentity:
    """用开放平台网站应用的 code 换身份。失败一律抛 422，不透微信原始错误码。"""
    if not code or not code.strip():
        raise Validation("缺少微信授权码，请重新发起登录")
    if settings.wechat_provider == MOCK:
        return _mock_identity(settings)
    return _exchange_identity(settings, settings.wechat_app_id, settings.wechat_app_secret, code.strip())


def exchange_h5_code(settings: Settings, *, code: str) -> WeChatIdentity:
    """用公众号网页授权的 code 换身份。"""
    if not code or not code.strip():
        raise Validation("缺少微信授权码，请重新发起登录")
    if settings.wechat_h5_provider == MOCK:
        return _mock_identity(settings)
    return _exchange_identity(
        settings, settings.wechat_h5_app_id, settings.wechat_h5_app_secret, code.strip()
    )


def _mock_identity(settings: Settings) -> WeChatIdentity:
    # 演示身份必须**稳定**：open_id 由随机 code 派生的话，每次扫码都是一张新「微信」，
    # 「绑定一次、之后免验证码」这条主路径永远走不到，演示价值为零。
    # 真实通道里 code 一次性、openid 恒定，mock 用固定值才对得上语义。
    # 扫码与 H5 共用同一个 mock 身份，演示时两端绑定可互通。
    return WeChatIdentity(
        provider=_PROVIDER_CODE[MOCK],
        open_id=settings.wechat_mock_open_id or "mock_demo_openid",
        nickname="微信演示用户",
    )


def _exchange_identity(settings: Settings, app_id: str, app_secret: str, code: str) -> WeChatIdentity:
    token_data = _get_json(
        _TOKEN_URL,
        {
            "appid": app_id,
            "secret": app_secret,
            "code": code,
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
    "MP",
    "OPEN_PLATFORM",
    "WeChatIdentity",
    "build_authorize_url",
    "build_h5_authorize_url",
    "exchange_code",
    "exchange_h5_code",
    "provider_code",
]
