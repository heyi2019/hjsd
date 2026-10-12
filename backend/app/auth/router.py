from __future__ import annotations

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import AuthError, Conflict, PermissionDenied, Validation
from app.core.security import (
    ALL_ROLES, CurrentUser, build_access_token, get_current_user, hash_password,
    verify_password, decode_token,
)
from app.domain.users import RevokedToken, Team, User

router = APIRouter(prefix="/auth", tags=["auth"])
admin_router = APIRouter(prefix="/users", tags=["users"])
teams_router = APIRouter(prefix="/teams", tags=["teams"])


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class PasswordChange(BaseModel):
    old_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class UserCreate(BaseModel):
    username: str = Field(min_length=2, max_length=64)
    display_name: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=8, max_length=128)
    role: str = "VIEWER"
    owner_scope: str = "SELF"
    pool_ids: list[int] = Field(default_factory=list)
    team_ids: list[int] = Field(default_factory=list)
    phone: str | None = None
    note: str | None = None


class UserUpdate(BaseModel):
    display_name: str | None = None
    role: str | None = None
    owner_scope: str | None = None
    pool_ids: list[int] | None = None
    team_ids: list[int] | None = None
    phone: str | None = None
    note: str | None = None
    is_active: bool | None = None


class TeamCreate(BaseModel):
    code: str = Field(min_length=2, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    description: str | None = None


class TeamUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    is_active: bool | None = None


def _public(user: User) -> dict:
    return {
        "id": user.id, "username": user.username, "display_name": user.display_name,
        "role": user.role, "owner_scope": user.owner_scope, "phone": user.phone,
        "pool_ids": user.pool_ids or [], "team_ids": user.team_ids or [],
        "is_active": user.is_active, "must_change_password": user.must_change_password,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


def _admin(actor: CurrentUser) -> None:
    if not actor.is_admin:
        raise PermissionDenied("仅系统管理员可管理用户")


def _check_team_ids(db: Session, team_ids: list[int] | None) -> None:
    if team_ids is None:
        return
    requested = set(team_ids)
    actual = {row[0] for row in db.execute(select(Team.id).where(Team.id.in_(requested))).all()}
    if actual != requested:
        raise Validation("团队不存在", details={"team_ids": sorted(requested - actual)})


@router.post("/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> dict:
    user = db.scalar(select(User).where(User.username == payload.username.strip()))
    if not user or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise AuthError("用户名或密码错误")
    current = CurrentUser.build(
        id=user.id, username=user.username, display_name=user.display_name,
        roles=[user.role], owner_scope=user.owner_scope,
        pool_ids=frozenset(user.pool_ids or []), team_ids=frozenset(user.team_ids or []),
    )
    return {"access_token": build_access_token(current), "token_type": "bearer", "user": _public(user)}


@router.get("/me")
def me(user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    record = db.get(User, user.id)
    return _public(record) if record else {
        "id": user.id, "username": user.username, "display_name": user.display_name,
        "role": user.roles[0] if user.roles else "VIEWER", "is_active": True,
    }


@router.post("/change-password")
def change_password(payload: PasswordChange, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    record = db.get(User, user.id)
    if not record or not verify_password(payload.old_password, record.password_hash):
        raise AuthError("原密码错误")
    record.password_hash = hash_password(payload.new_password)
    record.must_change_password = False
    return {"ok": True}


@router.post("/logout")
def logout(authorization: str | None = Header(default=None, alias="Authorization"), db: Session = Depends(get_db)) -> dict:
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() == "bearer" and token:
            payload = decode_token(token)
            jti = payload.get("jti")
            if jti:
                db.merge(RevokedToken(jti=jti, expires_at=int(payload.get("exp", 0))))
    return {"ok": True}


@admin_router.get("")
def list_users(actor: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> list[dict]:
    _admin(actor)
    return [_public(item) for item in db.scalars(select(User).order_by(User.id)).all()]


@admin_router.post("", status_code=201)
def create_user(payload: UserCreate, actor: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    _admin(actor)
    if payload.role not in ALL_ROLES:
        raise Validation("无效角色")
    if db.scalar(select(User).where(User.username == payload.username.strip())):
        raise Conflict("用户名已存在")
    _check_team_ids(db, payload.team_ids)
    item = User(username=payload.username.strip(), display_name=payload.display_name,
                password_hash=hash_password(payload.password), role=payload.role,
                owner_scope=payload.owner_scope, phone=payload.phone, note=payload.note,
                pool_ids=payload.pool_ids, team_ids=payload.team_ids,
                must_change_password=True)
    db.add(item); db.flush()
    return _public(item)


@admin_router.patch("/{user_id}")
def update_user(user_id: int, payload: UserUpdate, actor: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    _admin(actor)
    item = db.get(User, user_id)
    if not item:
        raise Validation("用户不存在")
    _check_team_ids(db, payload.team_ids)
    for key, value in payload.model_dump(exclude_unset=True).items():
        if key == "role" and value not in ALL_ROLES:
            raise Validation("无效角色")
        setattr(item, key, value)
    db.flush()
    return _public(item)


@admin_router.post("/{user_id}/reset-password")
def reset_password(user_id: int, payload: LoginRequest, actor: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    _admin(actor)
    item = db.get(User, user_id)
    if not item:
        raise Validation("用户不存在")
    item.password_hash = hash_password(payload.password)
    item.must_change_password = True
    return {"ok": True}


@teams_router.get("")
def list_teams(_user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> list[dict]:
    return [
        {"id": item.id, "code": item.code, "name": item.name, "description": item.description, "is_active": item.is_active}
        for item in db.scalars(select(Team).order_by(Team.id)).all()
    ]


@teams_router.post("", status_code=201)
def create_team(payload: TeamCreate, actor: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    _admin(actor)
    code = payload.code.strip().upper()
    if db.scalar(select(Team).where(Team.code == code)):
        raise Conflict("团队编码已存在")
    item = Team(code=code, name=payload.name.strip(), description=payload.description)
    db.add(item); db.flush()
    return {"id": item.id, "code": item.code, "name": item.name, "description": item.description, "is_active": item.is_active}


@teams_router.patch("/{team_id}")
def update_team(team_id: int, payload: TeamUpdate, actor: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    _admin(actor)
    item = db.get(Team, team_id)
    if not item:
        raise Validation("团队不存在")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(item, key, value)
    db.flush()
    return {"id": item.id, "code": item.code, "name": item.name, "description": item.description, "is_active": item.is_active}
