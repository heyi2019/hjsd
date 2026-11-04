"""手机号验证码登录 / 微信登录路由。

独立成文件的原因：`auth/router.py` 已承载账号密码登录与用户/团队管理，再塞两条
并行登录链路会让「谁能拿到 token」的路径变得难以审计。此处把所有**免密**登录
收在一处，便于一次性审阅安全边界：
  - 微信：open_id 已绑定 → 直接发 token；未绑定 → 必须过手机号校验
  - 手机号：必须命中 `users.phone` 且账号在职
两条链路都不创建账号（系统不开放注册）。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.auth import verification, wechat, wechat_service
from app.auth.router import _public as _public_user  # 复用同一份用户序列化口径
from app.core.database import get_db
from app.core.errors import PermissionDenied, RateLimited, Validation
from app.core.ratelimit import login_limiter
from app.core.schemas import RequestModel
from app.core.security import CurrentUser, build_access_token, get_current_user
from app.core.settings import Settings, get_settings
from app.domain.users import User

router = APIRouter(prefix="/auth", tags=["auth"])

_STATE_PURPOSE = "WECHAT_STATE"


class AuthorizeOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    authorize_url: str
    state: str


class WeChatLoginIn(RequestModel):
    code: str = Field(min_length=1, max_length=512)
    state: str = Field(min_length=1, max_length=2048)


class BindCodeIn(RequestModel):
    bind_ticket: str = Field(min_length=1, max_length=4096)
    phone: str = Field(min_length=4, max_length=32)


class BindConfirmIn(RequestModel):
    bind_ticket: str = Field(min_length=1, max_length=4096)
    phone: str = Field(min_length=4, max_length=32)
    code_ticket: str | None = Field(default=None, max_length=4096)
    code: str | None = Field(default=None, max_length=16)
    password: str | None = Field(default=None, max_length=128)


class PhoneCodeIn(RequestModel):
    phone: str = Field(min_length=4, max_length=32)


class PhoneLoginIn(RequestModel):
    phone: str = Field(min_length=4, max_length=32)
    code: str = Field(min_length=1, max_length=16)
    code_ticket: str = Field(min_length=1, max_length=4096)


class CodeOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sent: bool
    expires_in: int
    phone: str
    code_ticket: str
    # 仅 mock 通道 + 非生产环境返回，生产恒为 null（见 Settings.sms_code_deliverable）。
    dev_code: str | None = None


class PasswordlessLoginOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str
    access_token: str | None = None
    token_type: str = "bearer"
    user: dict | None = None
    bind_ticket: str | None = None
    verify_mode: str | None = None
    phone_hint: str | None = None
    message: str | None = None


class BindingOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    provider: str
    provider_label: str
    nickname: str | None = None
    avatar_url: str | None = None
    phone: str
    bound_at: str
    last_login_at: str | None = None


def _limits_enforced(settings: Settings) -> bool:
    """限流只在生产生效：与账号密码登录保持同一策略，避免打断本地联调与自动化。"""
    return settings.login_rate_limit_enabled and settings.app_env == "production"


def _guard(key: str, limit: int, window: int, settings: Settings, message: str) -> None:
    if _limits_enforced(settings) and not login_limiter.is_allowed(key, limit, window):
        raise RateLimited(message)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _token_payload(user: User) -> dict:
    current = CurrentUser.build(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        roles=[user.role],
        owner_scope=user.owner_scope,
        pool_ids=frozenset(user.pool_ids or []),
        team_ids=frozenset(user.team_ids or []),
    )
    return {
        "access_token": build_access_token(current),
        "token_type": "bearer",
        "user": _public_user(user),
    }


@router.get("/login-methods")
def login_methods(settings: Settings = Depends(get_settings)) -> dict:
    """登录页据此决定展示哪些入口。任何渠道未就绪都不点亮按钮。"""
    ready, reason = settings.wechat_ready
    return {
        "password": {"enabled": True},
        "phone_code": {
            "enabled": bool(settings.phone_code_login_enabled),
            "dev_code_visible": bool(settings.sms_code_deliverable and settings.app_env != "production"),
        },
        "wechat": {
            "enabled": bool(settings.wechat_effective_enabled and ready),
            "configured": bool(settings.wechat_effective_enabled),
            "provider": settings.wechat_provider,
            "verify_mode": settings.wechat_bind_verify_mode,
            "reason": reason,
        },
    }


@router.get("/wechat/authorize", response_model=AuthorizeOut)
def wechat_authorize(
    redirect_uri: str = "",
    settings: Settings = Depends(get_settings),
) -> AuthorizeOut:
    state = verification.issue_ticket(settings, purpose=_STATE_PURPOSE, phone="", ttl_seconds=600)
    if settings.wechat_provider == wechat.OPEN_PLATFORM:
        # 真实通道必须使用开放平台备案过的回调地址，不接受前端任意传参。
        target = settings.wechat_redirect_uri
    else:
        target = redirect_uri.strip() or settings.wechat_redirect_uri
    if not target:
        raise Validation("缺少微信回调地址，无法发起登录")
    return AuthorizeOut(
        authorize_url=wechat.build_authorize_url(settings, state=state, redirect_uri=target),
        state=state,
    )


@router.post("/wechat/login", response_model=PasswordlessLoginOut)
def wechat_login(
    payload: WeChatLoginIn,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> PasswordlessLoginOut:
    if not settings.wechat_effective_enabled:
        raise Validation("微信登录未启用")
    # state 是我们自己签发的，验签即证明本次回跳由本系统发起（CSRF 防护）。
    verification.read_ticket(settings, payload.state, purpose=_STATE_PURPOSE)
    _guard(f"wechat-login:{_client_ip(request)}", 20, 60, settings, "微信登录尝试过于频繁，请稍后再试")

    identity = wechat.exchange_code(settings, code=payload.code)
    result = wechat_service.resolve_login(db, settings, identity)

    if result.state == "logged_in" and result.user is not None:
        db.commit()
        return PasswordlessLoginOut(status="logged_in", **_token_payload(result.user))

    db.commit()
    return PasswordlessLoginOut(
        status="bind_required",
        bind_ticket=result.bind_ticket,
        verify_mode=settings.wechat_bind_verify_mode,
        message=result.reason or "请先绑定手机号",
    )


@router.post("/wechat/bind/code", response_model=CodeOut)
def wechat_bind_send_code(
    payload: BindCodeIn,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> CodeOut:
    if settings.wechat_bind_verify_mode != "sms":
        raise Validation("当前绑定方式为账号密码，无需验证码")
    phone = verification.normalize_phone(payload.phone)
    identity = wechat_service.read_bind_ticket(settings, payload.bind_ticket)
    # 先确认号码可绑，再发码：避免给「未开通」的号码白发一条短信。
    wechat_service.assert_phone_bindable(db, phone=phone, identity=identity)
    return _send_code(
        settings,
        request=request,
        phone=phone,
        purpose=verification.WECHAT_BIND,
        shared_key="wechat-bind",
    )


@router.post("/wechat/bind/confirm", response_model=PasswordlessLoginOut)
def wechat_bind_confirm(
    payload: BindConfirmIn,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> PasswordlessLoginOut:
    phone = verification.normalize_phone(payload.phone)
    identity = wechat_service.read_bind_ticket(settings, payload.bind_ticket)
    user = wechat_service.assert_phone_bindable(db, phone=phone, identity=identity)

    if settings.wechat_bind_verify_mode == "sms":
        if not payload.code_ticket or not payload.code:
            raise Validation("请先获取并填写短信验证码")
        _guard(
            f"wechat-bind-verify:{phone}", settings.sms_code_max_attempts, 600,
            settings, "验证码错误次数过多，请稍后重新获取",
        )
        verification.verify_code(
            settings,
            ticket=payload.code_ticket,
            purpose=verification.WECHAT_BIND,
            phone=phone,
            code=payload.code,
        )
    else:
        wechat_service.verify_bind_owner(db, user=user, identity=identity, password=payload.password)

    wechat_service.create_binding(db, user=user, identity=identity, phone=phone, actor=user.username)
    db.commit()
    return PasswordlessLoginOut(status="logged_in", **_token_payload(user))


@router.post("/phone/code", response_model=CodeOut)
def phone_send_code(
    payload: PhoneCodeIn,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> CodeOut:
    if not settings.phone_code_login_enabled:
        raise Validation("手机号验证码登录未启用")
    phone = verification.normalize_phone(payload.phone)
    # 未开通的号码到这里就拦住，不回「验证码已发送」的假成功。
    wechat_service.resolve_phone_user(db, phone)
    return _send_code(
        settings,
        request=request,
        phone=phone,
        purpose=verification.PHONE_LOGIN,
        shared_key="phone-login",
    )


@router.post("/phone/login", response_model=PasswordlessLoginOut)
def phone_login(
    payload: PhoneLoginIn,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> PasswordlessLoginOut:
    if not settings.phone_code_login_enabled:
        raise Validation("手机号验证码登录未启用")
    phone = verification.normalize_phone(payload.phone)
    _guard(
        f"phone-login-verify:{phone}", settings.sms_code_max_attempts, 600,
        settings, "验证码错误次数过多，请稍后重新获取",
    )
    verification.verify_code(
        settings, ticket=payload.code_ticket, purpose=verification.PHONE_LOGIN, phone=phone, code=payload.code
    )
    user = wechat_service.resolve_phone_user(db, phone)
    return PasswordlessLoginOut(status="logged_in", **_token_payload(user))


@router.get("/wechat/bindings", response_model=list[BindingOut])
def list_wechat_bindings(
    actor: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[BindingOut]:
    return [
        BindingOut(**wechat_service.as_dict(item))
        for item in wechat_service.list_bindings(db, actor.id)
    ]


@router.delete("/wechat/bindings/{binding_id}")
def delete_wechat_binding(
    binding_id: int,
    actor: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    bindings = wechat_service.list_bindings(db, actor.id)
    target = next((item for item in bindings if item.id == binding_id), None)
    if target is None:
        # 只能解绑自己的绑定；别人的 id 一律当作不存在，不泄漏是否存在。
        raise PermissionDenied("绑定不存在或无权操作")
    wechat_service.unbind(db, binding=target, actor=actor.username)
    db.commit()
    return {"ok": True}


def _send_code(
    settings: Settings,
    *,
    request: Request,
    phone: str,
    purpose: str,
    shared_key: str,
) -> CodeOut:
    """下发验证码的公共流程：限流 → 生成 → 走通道 → 回票据。"""
    if not settings.sms_code_deliverable:
        raise Validation("短信通道未配置，暂时无法使用验证码登录")

    _guard(
        f"{shared_key}-interval:{phone}", 1, max(30, settings.sms_resend_interval_seconds),
        settings, "验证码发送过于频繁，请稍后再试",
    )
    _guard(
        f"{shared_key}-hourly:{phone}", settings.sms_hourly_limit_per_phone, 3600,
        settings, "该手机号今日验证码次数过多，请稍后再试",
    )

    ticket, code, ttl = verification.issue_code(settings, purpose=purpose, phone=phone)
    delivery = _deliver(settings, phone=phone, code=code, purpose=purpose)
    return CodeOut(
        sent=True,
        expires_in=ttl,
        phone=verification.mask_phone(phone),
        code_ticket=ticket,
        dev_code=delivery.echo_code if settings.app_env != "production" else None,
    )


def _deliver(settings: Settings, *, phone: str, code: str, purpose: str):
    from app.auth.sms import deliver_code  # 局部导入：避免与 settings 形成启动期循环

    return deliver_code(settings, phone=phone, code=code, purpose=purpose)


__all__ = ["router"]
