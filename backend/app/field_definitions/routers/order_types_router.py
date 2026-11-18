"""业务类型主数据端点（BAS-02/03，从原 router.py 逐字拆出）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import CurrentUser
from app.auth.session import get_current_user
from app.core.actor import actor_name as _actor
from app.field_definitions import schemas
from app.field_definitions.order_types import (
    create_order_type as foundation_create_order_type,
    list_order_types as foundation_list_order_types,
    set_order_type_active as foundation_set_order_type_active,
    update_order_type as foundation_update_order_type,
)
from ..router_output import _order_type_output
from ._router_shared import manage_order_types

router = APIRouter(tags=["BAS-02/03 业务与资金主数据"])

# ------------------------------------------------------------------- 业务类型
@router.get("/order-types", response_model=list[schemas.OrderTypeOut])
def list_order_types(
    include_inactive: bool = Query(default=True),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> list[schemas.OrderTypeOut]:
    del user  # 登录即可读；数据范围由上层查询条件施加
    items = foundation_list_order_types(db, include_inactive=include_inactive)
    return [_order_type_output(item) for item in items]


@router.post("/order-types", response_model=schemas.OrderTypeOut, status_code=201)
def create_order_type(
    payload: schemas.OrderTypeCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_order_types,
) -> schemas.OrderTypeOut:
    order_type = foundation_create_order_type(
        db,
        code=payload.code,
        name=payload.name,
        is_zero_principal=payload.is_zero_principal,
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
    order_type = foundation_update_order_type(
        db,
        order_type_id,
        actor=_actor(user),
        name=payload.name,
        description=payload.description,
        sort_order=payload.sort_order,
        is_zero_principal=payload.is_zero_principal,
    )
    return _order_type_output(order_type)


@router.patch("/order-types/{order_type_id}/active", response_model=schemas.OrderTypeOut)
def set_order_type_active(
    order_type_id: int,
    is_active: bool = Query(...),
    db: Session = Depends(get_db),
    user: CurrentUser = manage_order_types,
) -> schemas.OrderTypeOut:
    order_type = foundation_set_order_type_active(db, order_type_id, is_active, actor=_actor(user))
    return _order_type_output(order_type)
