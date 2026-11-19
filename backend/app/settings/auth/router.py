from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import AuthError, PermissionDenied, RateLimited
from app.core.ratelimit import login_limiter
from app.core.schemas import RequestModel
from app.core.security import (
    PERM_ORDER_CREATE, PERM_REPORT_READ, CurrentUser, build_access_token, decode_token, verify_password,
)
from app.settings.auth.session import get_current_user
from app.core.settings import get_settings
from app.domain.users import Team, User
from app.settings.auth import service

router = APIRouter(prefix="/auth", tags=["auth"])
admin_router = APIRouter(prefix="/users", tags=["users"])
teams_router = APIRouter(prefix="/teams", tags=["teams"])


class LoginRequest(RequestModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class PasswordChange(RequestModel):
    old_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class PasswordResetRequest(RequestModel):
    model_config = ConfigDict(extra="forbid")

    password: str = Field(min_length=8, max_length=128)


class UserCreate(RequestModel):
    username: str = Field(min_length=2, max_length=64)
    display_name: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=8, max_length=128)
    role: str = "VIEWER"
    owner_scope: str = "SELF"
    pool_ids: list[int] = Field(default_factory=list)
    team_ids: list[int] = Field(default_factory=list)
    phone: str | None = None
    note: str | None = None


class UserUpdate(RequestModel):
    display_name: str | None = None
    role: str | None = None
    owner_scope: str | None = None
    pool_ids: list[int] | None = None
    team_ids: list[int] | None = None
    phone: str | None = None
    note: str | None = None
    is_active: bool | None = None
    handover_user_id: int | None = None
    handover_note: str | None = None


class TeamCreate(RequestModel):
    code: str = Field(min_length=2, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    description: str | None = None


class TeamUpdate(RequestModel):
    name: str | None = None
    description: str | None = None
    is_active: bool | None = None


class PublicUserOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    username: str
    display_name: str = ""
    role: str
    owner_scope: str = "SELF"
    phone: str | None = None
    pool_ids: list[int] = Field(default_factory=list)
    team_ids: list[int] = Field(default_factory=list)
    is_active: bool = True
    must_change_password: bool = False
    hired_on: str | None = None
    deactivated_on: str | None = None
    handover_user_id: int | None = None
    handover_note: str | None = None
    created_at: str | None = None


class LoginOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    access_token: str
    token_type: str
    user: PublicUserOut


class OkOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: bool


class TeamOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    code: str
    name: str
    description: str | None = None
    is_active: bool


def _public(user: User) -> dict:
    return {
        "id": user.id, "username": user.username, "display_name": user.display_name,
        "role": user.role, "owner_scope": user.owner_scope, "phone": user.phone,
        "pool_ids": user.pool_ids or [], "team_ids": user.team_ids or [],
        "is_active": user.is_active, "must_change_password": user.must_change_password,
        "hired_on": user.hired_on.isoformat() if user.hired_on else None,
        "deactivated_on": user.deactivated_on.isoformat() if user.deactivated_on else None,
        "handover_user_id": user.handover_user_id, "handover_note": user.handover_note,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


def _admin(actor: CurrentUser) -> None:
    if not actor.is_admin:
        raise PermissionDenied("仅系统管理员可管理用户")


def _client_ip(request: Request) -> str:
    """取真实客户端 IP 用于登录限流，必须抗伪造（否则攻击者每请求换一个
    X-Forwarded-For 首段即可绕过限流）。

    生产由前置 nginx 代理：nginx 以 `$remote_addr` **覆盖写入** X-Real-IP（客户端
    自带同名头会被覆盖，不可伪造），故最可信；X-Forwarded-For 用
    `$proxy_add_x_forwarded_for` **追加**真实对端到最右，客户端自带的伪造值只在左侧。
    因此取 X-Real-IP 优先、XFF 最右段兜底，**绝不取首段**。
    """
    real_ip = (request.headers.get("x-real-ip") or "").strip()
    if real_ip:
        return real_ip
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        parts = [seg.strip() for seg in forwarded.split(",") if seg.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else "unknown"


@router.post("/login", response_model=LoginOut)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)) -> LoginOut:
    # 登录限流：仅在生产生效（app_env=production），避免打断开发与 k6 压测。
    # PBKDF2 校验约 45ms/次，在 2 核服务器上暴力破解会显著挤占 CPU，故在 DB 查询前拦截。
    settings = get_settings()
    if settings.login_rate_limit_enabled and settings.is_production:
        if not login_limiter.is_allowed(
            f"login:{_client_ip(request)}", settings.login_rate_limit_per_minute, 60
        ):
            raise RateLimited("登录尝试过于频繁，请稍后再试")
    user = db.scalar(select(User).where(User.username == payload.username.strip()))
    if not user or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise AuthError("用户名或密码错误")
    current = CurrentUser.build(
        id=user.id, username=user.username, display_name=user.display_name,
        roles=[user.role], owner_scope=user.owner_scope,
        pool_ids=frozenset(user.pool_ids or []), team_ids=frozenset(user.team_ids or []),
    )
    return {"access_token": build_access_token(current), "token_type": "bearer", "user": _public(user)}


@router.get("/me", response_model=PublicUserOut)
def me(user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    record = db.get(User, user.id)
    payload = _public(record) if record else {
        "id": user.id, "username": user.username, "display_name": user.display_name,
        "role": user.roles[0] if user.roles else "VIEWER", "is_active": True,
    }
    return payload


@router.post("/change-password", response_model=OkOut)
def change_password(payload: PasswordChange, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> OkOut:
    service.change_password(
        db,
        user.id,
        old_password=payload.old_password,
        new_password=payload.new_password,
        actor=user.username,
    )
    return {"ok": True}


@router.post("/logout", response_model=OkOut)
def logout(authorization: str | None = Header(default=None, alias="Authorization"), db: Session = Depends(get_db)) -> OkOut:
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() == "bearer" and token:
            payload = decode_token(token)
            jti = payload.get("jti")
            if jti is not None and (not isinstance(jti, str) or not jti.strip()):
                raise AuthError("登录凭证内容无效")
            if jti:
                service.revoke_token(db, jti=jti, expires_at=int(payload.get("exp", 0)))
    return {"ok": True}


@admin_router.get("", response_model=list[PublicUserOut])
def list_users(actor: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> list[PublicUserOut]:
    _admin(actor)
    return [_public(item) for item in db.scalars(select(User).order_by(User.id)).all()]


@admin_router.get("/options", response_model=list[PublicUserOut])
def list_employee_options(actor: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> list[PublicUserOut]:
    """建单交付操作人选择器：允许可建单员工读取在职员工花名册。"""
    if not actor.has(PERM_ORDER_CREATE) and not actor.has(PERM_REPORT_READ):
        raise PermissionDenied("无权选择交付操作人")
    return [_public(item) for item in db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.id)).all()]


@admin_router.post("", response_model=PublicUserOut, status_code=201)
def create_user(payload: UserCreate, actor: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> PublicUserOut:
    _admin(actor)
    item = service.create_user(
        db,
        username=payload.username,
        display_name=payload.display_name,
        password=payload.password,
        role=payload.role,
        owner_scope=payload.owner_scope,
        pool_ids=payload.pool_ids,
        team_ids=payload.team_ids,
        phone=payload.phone,
        note=payload.note,
        actor=actor.username,
    )
    return _public(item)


@admin_router.patch("/{user_id}", response_model=PublicUserOut)
def update_user(user_id: int, payload: UserUpdate, actor: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> PublicUserOut:
    _admin(actor)
    item = service.update_user(
        db,
        user_id,
        changes=payload.model_dump(exclude_unset=True),
        actor=actor.username,
    )
    return _public(item)


@admin_router.post("/{user_id}/reset-password", response_model=OkOut)
def reset_password(user_id: int, payload: PasswordResetRequest, actor: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> OkOut:
    _admin(actor)
    service.reset_password(db, user_id, password=payload.password, actor=actor.username)
    return {"ok": True}


@teams_router.get("", response_model=list[TeamOut])
def list_teams(_user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> list[TeamOut]:
    return [
        {"id": item.id, "code": item.code, "name": item.name, "description": item.description, "is_active": item.is_active}
        for item in db.scalars(select(Team).order_by(Team.id)).all()
    ]


@teams_router.post("", response_model=TeamOut, status_code=201)
def create_team(payload: TeamCreate, actor: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> TeamOut:
    _admin(actor)
    item = service.create_team(
        db,
        code=payload.code,
        name=payload.name,
        description=payload.description,
        actor=actor.username,
    )
    return {"id": item.id, "code": item.code, "name": item.name, "description": item.description, "is_active": item.is_active}


@teams_router.patch("/{team_id}", response_model=TeamOut)
def update_team(team_id: int, payload: TeamUpdate, actor: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> TeamOut:
    _admin(actor)
    item = service.update_team(
        db,
        team_id,
        changes=payload.model_dump(exclude_unset=True),
        actor=actor.username,
    )
    return {"id": item.id, "code": item.code, "name": item.name, "description": item.description, "is_active": item.is_active}
