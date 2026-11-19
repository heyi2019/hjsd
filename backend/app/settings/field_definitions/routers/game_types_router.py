"""游戏类型主数据端点（BAS-02/03，从原 router.py 逐字拆出）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import CurrentUser
from app.settings.auth.session import get_current_user
from app.core.actor import actor_name as _actor
from app.settings.field_definitions import schemas
from app.settings.field_definitions.game_types import (
    create_game_type as foundation_create_game_type,
    delete_game_type as foundation_delete_game_type,
    list_game_types as foundation_list_game_types,
    set_game_type_active as foundation_set_game_type_active,
    set_game_type_default as foundation_set_game_type_default,
    update_game_type as foundation_update_game_type,
)
from ._router_shared import manage_game_types

router = APIRouter(tags=["BAS-02/03 业务与资金主数据"])

# ------------------------------------------------------------------- 游戏类型标准
@router.get("/game-types", response_model=list[schemas.GameTypeOut])
def list_game_types(
    include_inactive: bool = Query(default=True),
    db: Session = Depends(get_db),
    _user: CurrentUser = Depends(get_current_user),
) -> list[schemas.GameTypeOut]:
    return [
        schemas.GameTypeOut.model_validate(item)
        for item in foundation_list_game_types(db, include_inactive=include_inactive)
    ]


@router.post("/game-types", response_model=schemas.GameTypeOut, status_code=201)
def create_game_type(
    payload: schemas.GameTypeCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_game_types,
) -> schemas.GameTypeOut:
    item = foundation_create_game_type(
        db,
        name=payload.name,
        sort_order=payload.sort_order,
        is_default=payload.is_default,
        channel_regions=payload.channel_regions,
        actor=_actor(user),
    )
    return schemas.GameTypeOut.model_validate(item)


@router.patch("/game-types/{game_type_id}", response_model=schemas.GameTypeOut)
def update_game_type(
    game_type_id: int,
    payload: schemas.GameTypeUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_game_types,
) -> schemas.GameTypeOut:
    item = foundation_update_game_type(db, game_type_id, actor=_actor(user), **payload.model_dump(exclude_unset=True))
    return schemas.GameTypeOut.model_validate(item)


@router.patch("/game-types/{game_type_id}/active", response_model=schemas.GameTypeOut)
def set_game_type_active(
    game_type_id: int,
    active: bool = Query(...),
    db: Session = Depends(get_db),
    user: CurrentUser = manage_game_types,
) -> schemas.GameTypeOut:
    item = foundation_set_game_type_active(db, game_type_id, active, actor=_actor(user))
    return schemas.GameTypeOut.model_validate(item)


@router.patch("/game-types/{game_type_id}/default", response_model=schemas.GameTypeOut)
def set_game_type_default(
    game_type_id: int,
    is_default: bool = Query(...),
    db: Session = Depends(get_db),
    user: CurrentUser = manage_game_types,
) -> schemas.GameTypeOut:
    item = foundation_set_game_type_default(db, game_type_id, is_default, actor=_actor(user))
    return schemas.GameTypeOut.model_validate(item)


@router.delete("/game-types/{game_type_id}", status_code=204)
def delete_game_type(
    game_type_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_game_types,
) -> Response:
    foundation_delete_game_type(db, game_type_id, actor=_actor(user))
    db.commit()
    return Response(status_code=204)
