from __future__ import annotations

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import AuthError, PermissionDenied
from app.core.schemas import RequestModel
from app.core.security import (
    CurrentUser, build_access_token, get_current_user, decode_token, verify_password,
)
from app.domain.users import Team, User
from app.auth import service

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


@router.post("/login", response_model=LoginOut)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> LoginOut:
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
def me(user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> PublicUserOut:
    record = db.get(User, user.id)
    return _public(record) if record else {
        "id": user.id, "username": user.username, "display_name": user.display_name,
        "role": user.roles[0] if user.roles else "VIEWER", "is_active": True,
    }


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
