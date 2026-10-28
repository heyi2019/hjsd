"""foundation.router：基础主数据 API（BAS-02 / BAS-03）。

端点与《ERP_API接口规范_v1.0.md》一致：
- GET/POST `/pools`、PATCH `/pools/{id}`、PATCH `/pools/{id}/status`、DELETE `/pools/{id}`；
- GET/POST `/order-types`、GET/POST `/order-types/{code}/routes`；
- GET `/sequences`（编号域与下一个可用编号）。

写接口由 Service 事务执行并写审计；越权统一 `403 PERMISSION_DENIED`。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import Validation
from app.core.numbering import MAX_SEQUENCE_VALUE, format_next_number
from app.core.security import (
    PERM_FINANCE_READ,
    PERM_ORDER_TYPE_MANAGE,
    PERM_POOL_MANAGE,
    CurrentUser,
    get_current_user,
    require_permissions,
)
from app.foundation import schemas, service
from app.foundation.classification import classification_for_order_type
from app.parties import service as parties_service

router = APIRouter(tags=["BAS-02/03 业务与资金主数据"])

read_access = require_permissions(PERM_FINANCE_READ, PERM_POOL_MANAGE, require_all=False)
manage_pools = require_permissions(PERM_POOL_MANAGE)
manage_order_types = require_permissions(PERM_ORDER_TYPE_MANAGE)
manage_game_types = require_permissions(PERM_ORDER_TYPE_MANAGE)


def _actor(user: CurrentUser) -> str:
    return user.username


def _pool_output(db: Session, pool) -> schemas.PoolOut:
    output = schemas.PoolOut.model_validate(pool)
    output.extra_values = parties_service.get_extra_values(
        db, entity_type="pool", entity_id=pool.id
    )
    return output


def _order_type_output(order_type) -> schemas.OrderTypeOut:
    payload = schemas.OrderTypeOut.model_validate(order_type)
    classification = classification_for_order_type(order_type.code)
    if classification:
        payload.business_mode = classification["business_mode"]
        payload.business_type = classification["business_type"]
        payload.value_added_service = classification["value_added_service"]
    return payload


# ------------------------------------------------------------------- 游戏类型标准
@router.get("/game-types", response_model=list[schemas.GameTypeOut])
def list_game_types(
    include_inactive: bool = Query(default=True),
    db: Session = Depends(get_db),
    _user: CurrentUser = Depends(get_current_user),
) -> list[schemas.GameTypeOut]:
    return [
        schemas.GameTypeOut.model_validate(item)
        for item in service.list_game_types(db, include_inactive=include_inactive)
    ]


@router.post("/game-types", response_model=schemas.GameTypeOut, status_code=201)
def create_game_type(
    payload: schemas.GameTypeCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_game_types,
) -> schemas.GameTypeOut:
    item = service.create_game_type(
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
    item = service.update_game_type(db, game_type_id, actor=_actor(user), **payload.model_dump(exclude_unset=True))
    return schemas.GameTypeOut.model_validate(item)


@router.patch("/game-types/{game_type_id}/active", response_model=schemas.GameTypeOut)
def set_game_type_active(
    game_type_id: int,
    active: bool = Query(...),
    db: Session = Depends(get_db),
    user: CurrentUser = manage_game_types,
) -> schemas.GameTypeOut:
    item = service.set_game_type_active(db, game_type_id, active, actor=_actor(user))
    return schemas.GameTypeOut.model_validate(item)


@router.patch("/game-types/{game_type_id}/default", response_model=schemas.GameTypeOut)
def set_game_type_default(
    game_type_id: int,
    is_default: bool = Query(...),
    db: Session = Depends(get_db),
    user: CurrentUser = manage_game_types,
) -> schemas.GameTypeOut:
    item = service.set_game_type_default(db, game_type_id, is_default, actor=_actor(user))
    return schemas.GameTypeOut.model_validate(item)


@router.delete("/game-types/{game_type_id}", status_code=204)
def delete_game_type(
    game_type_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_game_types,
) -> Response:
    service.delete_game_type(db, game_type_id, actor=_actor(user))
    db.commit()
    return Response(status_code=204)


# --------------------------------------------------------------------- 资金池
@router.get("/pools", response_model=list[schemas.PoolOut])
def list_pools(
    include_disabled: bool = Query(default=True),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> list[schemas.PoolOut]:
    pools = service.list_pools(db, include_disabled=include_disabled, user=_user)
    extras = parties_service.get_extra_values_bulk(
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
    pool = service.create_pool(
        db,
        code=payload.code,
        name=payload.name,
        actor=_actor(user),
        pool_type=payload.pool_type,
        ownership=payload.ownership.value,
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
    if "ownership" in changes and changes["ownership"] is not None:
        changes["ownership"] = changes["ownership"].value
    pool = service.update_pool(db, pool_id, actor=_actor(user), **changes)
    return _pool_output(db, pool)


@router.patch("/pools/{pool_id}/status", response_model=schemas.PoolOut)
def set_pool_status(
    pool_id: int,
    payload: schemas.PoolStatusUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_pools,
) -> schemas.PoolOut:
    pool = service.set_pool_status(db, pool_id, payload.status.value, actor=_actor(user))
    return _pool_output(db, pool)


@router.delete("/pools/{pool_id}", status_code=204)
def delete_pool(
    pool_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_pools,
) -> Response:
    """V17：有流水的池会被 Service 拦下来，此处不提供绕过开关。"""
    service.delete_pool(db, pool_id, actor=_actor(user))
    return Response(status_code=204)


# ------------------------------------------------------------------- 业务类型
@router.get("/order-types", response_model=list[schemas.OrderTypeOut])
def list_order_types(
    include_inactive: bool = Query(default=True),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[schemas.OrderTypeOut]:
    del user  # 登录即可读；数据范围由上层查询条件施加
    items = service.list_order_types(db, include_inactive=include_inactive)
    return [_order_type_output(item) for item in items]


@router.post("/order-types", response_model=schemas.OrderTypeOut, status_code=201)
def create_order_type(
    payload: schemas.OrderTypeCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_order_types,
) -> schemas.OrderTypeOut:
    order_type = service.create_order_type(
        db,
        code=payload.code,
        name=payload.name,
        capital_type=payload.capital_type.value,
        actor=_actor(user),
        sequence_prefix=payload.sequence_prefix,
        sort_order=payload.sort_order,
        description=payload.description,
    )
    return _order_type_output(order_type)


@router.patch("/order-types/{order_type_id}", response_model=schemas.OrderTypeOut)
def update_order_type(
    order_type_id: int,
    payload: schemas.OrderTypeUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_order_types,
) -> schemas.OrderTypeOut:
    order_type = service.update_order_type(
        db,
        order_type_id,
        actor=_actor(user),
        name=payload.name,
        description=payload.description,
        sort_order=payload.sort_order,
    )
    return _order_type_output(order_type)


@router.patch("/order-types/{order_type_id}/active", response_model=schemas.OrderTypeOut)
def set_order_type_active(
    order_type_id: int,
    is_active: bool = Query(...),
    db: Session = Depends(get_db),
    user: CurrentUser = manage_order_types,
) -> schemas.OrderTypeOut:
    order_type = service.set_order_type_active(db, order_type_id, is_active, actor=_actor(user))
    return _order_type_output(order_type)


@router.get("/order-types/{order_type_id}/routes", response_model=list[schemas.RouteOut])
def list_routes(
    order_type_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[schemas.RouteOut]:
    del user
    routes = service.list_routes(db, order_type_id=order_type_id)
    return [
        schemas.RouteOut(
            id=route.id,
            order_type_code=route.order_type.code,
            portion=route.portion,
            fund_nature=route.fund_nature,
            pool_code=route.pool.code,
            pool_name=route.pool.name,
            priority=route.priority,
            is_active=route.is_active,
        )
        for route in routes
    ]


@router.post("/order-types/{code}/routes", response_model=schemas.RouteOut, status_code=201)
def set_route(
    code: str,
    payload: schemas.RouteIn,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_order_types,
) -> schemas.RouteOut:
    route = service.set_route(
        db,
        order_type_code=code,
        portion=payload.portion.value,
        pool_code=payload.pool_code,
        fund_nature=payload.fund_nature.value if payload.fund_nature else None,
        actor=_actor(user),
        priority=payload.priority,
    )
    return schemas.RouteOut(
        id=route.id,
        order_type_code=route.order_type.code,
        portion=route.portion,
        fund_nature=route.fund_nature,
        pool_code=route.pool.code,
        pool_name=route.pool.name,
        priority=route.priority,
        is_active=route.is_active,
    )


@router.get(
    "/order-types/{code}/routes/impact-preview",
    response_model=schemas.RouteImpactPreviewOut,
)
def route_impact_preview(
    code: str,
    portion: schemas.Portion = Query(...),
    fund_nature: schemas.FundNature | None = Query(default=None),
    pool_code: str = Query(..., min_length=2, max_length=64),
    db: Session = Depends(get_db),
    _user: CurrentUser = manage_order_types,
) -> schemas.RouteImpactPreviewOut:
    return schemas.RouteImpactPreviewOut.model_validate(
        service.route_impact_preview(
            db,
            order_type_code=code,
            portion=portion.value,
            pool_code=pool_code,
            fund_nature=fund_nature.value if fund_nature else None,
        )
    )


# ----------------------------------------------------------------------- 编号
@router.get("/sequences", response_model=list[schemas.SequenceOut])
def list_sequences(
    db: Session = Depends(get_db),
    user: CurrentUser = manage_order_types,
) -> list[schemas.SequenceOut]:
    del user
    result: list[schemas.SequenceOut] = []
    for sequence in service.list_sequences(db):
        next_number = ""
        try:
            # 序列行已随列表取出，直接按同一口径格式化；
            # 逐行 peek_number 会把已加载的行再回查一遍（实测 16 条冗余 SELECT）。
            next_number = format_next_number(
                sequence_key=sequence.sequence_key,
                prefix=sequence.prefix,
                padding=sequence.padding,
                current_value=sequence.current_value,
            )
        except Validation:
            next_number = f"<已达上限 {MAX_SEQUENCE_VALUE}>"
        result.append(
            schemas.SequenceOut(
                sequence_key=sequence.sequence_key,
                prefix=sequence.prefix,
                padding=sequence.padding,
                current_value=sequence.current_value,
                next_number=next_number,
            )
        )
    return result


__all__ = ["router"]
