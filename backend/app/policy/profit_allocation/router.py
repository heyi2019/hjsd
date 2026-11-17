"""订单分润配置接口。

接口只保存利润归属配置，不创建资金流水。
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import PERM_ORDER_CREATE, PERM_POLICY_MANAGE, CurrentUser
from app.auth.session import require_permissions
from . import listing, schemas, service, terms

router = APIRouter(tags=["policy"])
manage_access = require_permissions(PERM_POLICY_MANAGE)
read_access = require_permissions(PERM_ORDER_CREATE)


@router.get("/orders/{order_id}/profit-allocations", response_model=schemas.ProfitAllocationListOut)
def list_allocations(
    order_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
) -> schemas.ProfitAllocationListOut:
    items = listing.list_allocations(db, order_id, user=user)
    terms_result = terms.allocation_terms(db, order_id, user=user)
    return schemas.ProfitAllocationListOut(
        items=[schemas.ProfitAllocationOut.model_validate(item) for item in items],
        total=len(items),
        order_profit=terms_result["order_profit"],
        company_rate=terms_result["company_rate"],
        allocatable_profit=terms_result["allocatable_profit"],
        totals_by_type=listing.summarize_allocations_by_type(items),
    )


@router.post(
    "/orders/{order_id}/profit-allocations/convert",
    response_model=schemas.ProfitAllocationConvertOut,
)
def convert_allocation_value(
    order_id: int,
    payload: schemas.ProfitAllocationConvertIn,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = manage_access,
) -> schemas.ProfitAllocationConvertOut:
    converted = terms.convert_action_allocation(
        db,
        order_id,
        direction=payload.direction,
        value=payload.value,
        user=user,
    )
    return schemas.ProfitAllocationConvertOut(value=converted)


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
    terms_result = terms.allocation_terms(db, order_id, user=user)
    return schemas.ProfitAllocationListOut(
        items=[schemas.ProfitAllocationOut.model_validate(item) for item in items],
        total=len(items),
        order_profit=terms_result["order_profit"],
        company_rate=terms_result["company_rate"],
        allocatable_profit=terms_result["allocatable_profit"],
        totals_by_type=listing.summarize_allocations_by_type(items),
    )


__all__ = ["router"]
