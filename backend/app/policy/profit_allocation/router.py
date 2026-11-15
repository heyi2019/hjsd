"""订单分润配置接口。

接口只保存利润归属配置，不创建资金流水。
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import PERM_ORDER_CREATE, PERM_POLICY_MANAGE, CurrentUser, require_permissions
from app.orders.amounts import order_amounts

from . import schemas, service

router = APIRouter(tags=["policy"])
manage_access = require_permissions(PERM_POLICY_MANAGE)
read_access = require_permissions(PERM_ORDER_CREATE)


@router.get("/orders/{order_id}/profit-allocations", response_model=schemas.ProfitAllocationListOut)
def list_allocations(
    order_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
) -> schemas.ProfitAllocationListOut:
    items = service.list_allocations(db, order_id, user=user)
    return schemas.ProfitAllocationListOut(
        items=[schemas.ProfitAllocationOut.model_validate(item) for item in items],
        total=len(items),
        order_profit=order_amounts(db, order_id)["PROFIT"],
    )


@router.put("/orders/{order_id}/profit-allocations", response_model=schemas.ProfitAllocationListOut)
def set_allocations(
    order_id: int,
    payload: schemas.ProfitAllocationSet,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = manage_access,
) -> schemas.ProfitAllocationListOut:
    items = service.set_allocations(
        db,
        order_id,
        items=[item.model_dump() for item in payload.items],
        actor=user.username,
        form_extra=payload.form_extra,
        user=user,
    )
    return schemas.ProfitAllocationListOut(
        items=[schemas.ProfitAllocationOut.model_validate(item) for item in items],
        total=len(items),
        order_profit=order_amounts(db, order_id)["PROFIT"],
    )


__all__ = ["router"]
