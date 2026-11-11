"""手机号 / 微信登录的领域逻辑。

核心口径（2026-11-05 用户裁决）：
1. **只有后台已配置手机号的在职用户**才能用手机号验证码或微信登录；系统不开放注册，
   账号一律由管理员在「设置-用户」里创建。
2. 微信首次登录必须先绑定手机号，且该手机号必须与 `users.phone` **完全一致**；
   绑定之后免验证码，直接凭 open_id 登录。
3. 账号手机号被改掉后，旧绑定自动失效，需要按新手机号重新绑定
   （否则「手机号已换人」的账号会被前一个微信继续持有）。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import AuthError, Conflict, Validation
from app.core.security import verify_password
from app.core.settings import Settings
from app.core.time import now_second
from app.domain.enums import AuditAction
from app.domain.users import User, UserWeChatBinding
from app.auth import verification
from app.auth.wechat import WeChatIdentity


@dataclass(frozen=True)
class LoginResolution:
    """一次微信登录的判定结果。

    state:
      - `logged_in`：已绑定且有效，携带 user
      - `bind_required`：未绑定 / 绑定失效，携带给前端的绑定票据
    """

    state: str
    user: User | None = None
    bind_ticket: str | None = None
    reason: str | None = None


def resolve_phone_user(db: Session, phone: str) -> User:
    """按手机号找可登录的账号；找不到就明确拒绝（不区分「未配置」与「已停用」）。"""
    verification.assert_valid_phone(phone)
    user = db.scalar(select(User).where(User.phone == phone))
    if user is None or not user.is_active:
        # 这里刻意不区分「未配置」与「已停用」：两者对使用者都是「不能用」，
        # 分开提示只会泄漏账号状态。
        raise AuthError("该手机号未开通登录，请联系管理员")
    return user


def find_binding(db: Session, *, provider: str, open_id: str) -> UserWeChatBinding | None:
    return db.scalar(
        select(UserWeChatBinding).where(
            UserWeChatBinding.provider == provider,
            UserWeChatBinding.open_id == open_id,
            UserWeChatBinding.is_active.is_(True),
        )
    )


def list_bindings(db: Session, user_id: int) -> list[UserWeChatBinding]:
    return list(
        db.scalars(
            select(UserWeChatBinding)
            .where(UserWeChatBinding.user_id == user_id, UserWeChatBinding.is_active.is_(True))
            .order_by(UserWeChatBinding.id)
        ).all()
    )


def _deactivate(db: Session, binding: UserWeChatBinding) -> None:
    binding.is_active = False


def _audit_auto_unbind(db: Session, binding: UserWeChatBinding, reason: str) -> None:
    """惰性失效（账号停用 / 手机号变更）也留审计——绑定被谁、为何作废必须可追溯。"""
    record_audit(
        db,
        action=AuditAction.WECHAT_UNBIND,
        entity_type="user",
        entity_id=binding.user_id,
        actor="system",
        before={
            "provider": binding.provider,
            "open_id": binding.open_id,
            "phone": verification.mask_phone(binding.bound_phone or ""),
        },
        reason=reason,
    )


def resolve_login(db: Session, settings: Settings, identity: WeChatIdentity) -> LoginResolution:
    """已绑定就直接登录；未绑定或绑定失效则下发绑定票据。"""
    binding = find_binding(db, provider=identity.provider, open_id=identity.open_id)
    if binding is not None:
        user = db.get(User, binding.user_id)
        if user is None or not user.is_active:
            _deactivate(db, binding)
            _audit_auto_unbind(db, binding, "绑定账号不存在或已停用，微信绑定自动失效")
            db.flush()
            raise AuthError("绑定账号已停用，请联系管理员")
        if user.phone != binding.bound_phone:
            # 手机号已变更：旧微信不再代表该账号，作废绑定并要求重新绑定。
            _deactivate(db, binding)
            _audit_auto_unbind(db, binding, "账号手机号已变更，旧微信绑定自动失效")
            db.flush()
            return LoginResolution(
                state="bind_required",
                bind_ticket=_issue_bind_ticket(settings, identity),
                reason="账号手机号已变更，请重新绑定微信",
            )
        binding.last_login_at = now_second()
        return LoginResolution(state="logged_in", user=user)

    return LoginResolution(
        state="bind_required",
        bind_ticket=_issue_bind_ticket(settings, identity),
        reason="首次使用微信登录，请先绑定手机号",
    )


def _issue_bind_ticket(settings: Settings, identity: WeChatIdentity) -> str:
    return verification.issue_ticket(
        settings,
        purpose=verification.WECHAT_BIND,
        phone="",
        ttl_seconds=settings.wechat_bind_ticket_seconds,
        open_id=identity.open_id,
        union_id=identity.union_id,
        provider=identity.provider,
        nickname=identity.nickname,
        avatar_url=identity.avatar_url,
    )


def read_bind_ticket(settings: Settings, ticket: str) -> WeChatIdentity:
    payload = verification.read_ticket(settings, ticket, purpose=verification.WECHAT_BIND)
    open_id = str(payload.get("open_id") or "").strip()
    provider = str(payload.get("provider") or "").strip()
    if not open_id or not provider:
        raise Validation("绑定凭证内容不完整，请重新发起微信登录")
    return WeChatIdentity(
        provider=provider,
        open_id=open_id,
        union_id=payload.get("union_id") or None,
        nickname=payload.get("nickname") or None,
        avatar_url=payload.get("avatar_url") or None,
    )


def assert_phone_bindable(db: Session, *, phone: str, identity: WeChatIdentity) -> User:
    """手机号必须是已配置的在职账号，且该账号/该微信都还没有别的绑定。"""
    user = resolve_phone_user(db, phone)

    existing_for_user = db.scalar(
        select(UserWeChatBinding).where(
            UserWeChatBinding.user_id == user.id,
            UserWeChatBinding.provider == identity.provider,
            UserWeChatBinding.is_active.is_(True),
        )
    )
    if existing_for_user is not None and existing_for_user.open_id != identity.open_id:
        raise Conflict("该账号已绑定其他微信，请先在用户中心解绑")

    other = find_binding(db, provider=identity.provider, open_id=identity.open_id)
    if other is not None and other.user_id != user.id:
        # 同一微信已绑到别人身上：说明手机号填错了，或换号后旧绑定未清理。
        raise Conflict("该微信已绑定其他账号，请先解绑后再试")

    return user


def verify_bind_owner(db: Session, *, user: User, identity: WeChatIdentity, password: str | None) -> None:
    """password 模式下的二次确认：必须知道该账号密码，防止「知道手机号就能绑」。"""
    if not password or not verify_password(password, user.password_hash):
        raise AuthError("账号密码错误，无法绑定微信")


def create_binding(
    db: Session,
    *,
    user: User,
    identity: WeChatIdentity,
    phone: str,
    actor: str,
) -> UserWeChatBinding:
    binding = db.scalar(
        select(UserWeChatBinding).where(
            UserWeChatBinding.user_id == user.id,
            UserWeChatBinding.provider == identity.provider,
        )
    )
    if binding is None:
        binding = UserWeChatBinding(
            user_id=user.id,
            provider=identity.provider,
            open_id=identity.open_id,
        )
        db.add(binding)
    # 复用同一行（含已停用的）：唯一约束 (user_id, provider) 不允许插第二行。
    binding.open_id = identity.open_id
    binding.union_id = identity.union_id
    binding.nickname = identity.nickname
    binding.avatar_url = identity.avatar_url
    binding.bound_phone = phone
    binding.is_active = True
    binding.last_login_at = now_second()
    db.flush()

    record_audit(
        db,
        action=AuditAction.WECHAT_BIND,
        entity_type="user",
        entity_id=user.id,
        actor=actor,
        after={
            "provider": identity.provider,
            "open_id": identity.open_id,
            "phone": verification.mask_phone(phone),
        },
        reason="微信登录绑定手机号",
    )
    return binding


def unbind(db: Session, *, binding: UserWeChatBinding, actor: str) -> None:
    before = {
        "provider": binding.provider,
        "open_id": binding.open_id,
        "phone": verification.mask_phone(binding.bound_phone or ""),
    }
    _deactivate(db, binding)
    db.flush()
    record_audit(
        db,
        action=AuditAction.WECHAT_UNBIND,
        entity_type="user",
        entity_id=binding.user_id,
        actor=actor,
        before=before,
        reason="微信登录解绑",
    )


def touch_login(db: Session, binding: UserWeChatBinding) -> None:
    binding.last_login_at = now_second()


def as_dict(binding: UserWeChatBinding) -> dict:
    return {
        "id": binding.id,
        "provider": binding.provider,
        "provider_label": "微信（演示通道）" if binding.provider == "MOCK" else "微信",
        "nickname": binding.nickname,
        "avatar_url": binding.avatar_url,
        "phone": verification.mask_phone(binding.bound_phone or ""),
        "bound_at": (binding.created_at or datetime.now()).isoformat(),
        "last_login_at": binding.last_login_at.isoformat() if binding.last_login_at else None,
    }


__all__ = [
    "LoginResolution",
    "as_dict",
    "assert_phone_bindable",
    "create_binding",
    "find_binding",
    "list_bindings",
    "read_bind_ticket",
    "resolve_login",
    "resolve_phone_user",
    "touch_login",
    "unbind",
    "verify_bind_owner",
]
