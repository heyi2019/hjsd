"""资金账户（资金池）主数据端点（BAS-02/03，从原 router.py 逐字拆出）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import CurrentUser
from app.core.actor import actor_name as _actor
from app.shared.form_values import get_extra_values_bulk
from app.settings.field_definitions import schemas
from app.settings.field_definitions.pools import (
    create_pool as foundation_create_pool,
    delete_pool as foundation_delete_pool,
    list_pools as foundation_list_pools,
    set_pool_status as foundation_set_pool_status,
    update_pool as foundation_update_pool,
)
from ..router_output import _pool_output
from ._router_shared import manage_pools, read_access

router = APIRouter(tags=["BAS-02/03 业务与资金主数据"])

# --------------------------------------------------------------------- 资金账户
@router.get("/pools", response_model=list[schemas.PoolOut])
def list_pools(
    include_disabled: bool = Query(default=True),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> list[schemas.PoolOut]:
    pools = foundation_list_pools(db, include_disabled=include_disabled, user=_user)
    extras = get_extra_values_bulk(
        db, entity_type="pool", entity_ids=[pool.id for pool in pools]
    )
    return [
        schemas.PoolOut.model_validate({**pool.__dict__, "extra_values": extras.get(pool.id, {})})
        for pool in pools
    ]


@router.post("/pools", response_model=schemas.PoolOut, status_code=201)
def create_pool(
    payload: schemas.PoolCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_pools,
) -> schemas.PoolOut:
    pool = foundation_create_pool(
        db,
        name=payload.name,
        actor=_actor(user),
        pool_type=payload.pool_type,
        is_default=payload.is_default,
        note=payload.note,
        extra_values=payload.extra_values,
    )
    return _pool_output(db, pool)


@router.patch("/pools/{pool_id}", response_model=schemas.PoolOut)
def update_pool(
    pool_id: int,
    payload: schemas.PoolUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_pools,
) -> schemas.PoolOut:
    changes = payload.model_dump(exclude_unset=True)
    pool = foundation_update_pool(db, pool_id, actor=_actor(user), **changes)
    return _pool_output(db, pool)


@router.patch("/pools/{pool_id}/status", response_model=schemas.PoolOut)
def set_pool_status(
    pool_id: int,
    payload: schemas.PoolStatusUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_pools,
) -> schemas.PoolOut:
    pool = foundation_set_pool_status(db, pool_id, payload.status.value, actor=_actor(user))
    return _pool_output(db, pool)


@router.delete("/pools/{pool_id}", status_code=204)
def delete_pool(
    pool_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_pools,
) -> Response:
    """V17：有流水的池会被 Service 拦下来，此处不提供绕过开关。"""
    foundation_delete_pool(db, pool_id, actor=_actor(user))
    return Response(status_code=204)
