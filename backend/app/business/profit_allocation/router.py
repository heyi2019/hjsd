"""订单分润配置 HTTP 接口（薄壳）。

接口只保存利润归属配置，不创建资金流水。所有业务编排收敛在主体服务
:mod:`app.business.profit_allocation.service`；本模块只做鉴权、入参/响应契约映射。
"""
from __future__ import annotations

from typing import Annotated
from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import PERM_ORDER_CREATE, PERM_POLICY_MANAGE, CurrentUser
from app.settings.auth.session import require_permissions
from . import schemas, service
from .company_settings import CompanyProfitSettings, get_company_settings, update_company_settings

router = APIRouter(tags=["profit-allocation"])
manage_access = require_permissions(PERM_POLICY_MANAGE)
read_access = require_permissions(PERM_ORDER_CREATE)


def _allocation_response(view: dict) -> schemas.ProfitAllocationListOut:
    return schemas.ProfitAllocationListOut(
        items=[schemas.ProfitAllocationOut.model_validate(item) for item in view["items"]],
        total=view["total"],
        order_profit=view["order_profit"],
        company_rate=view["company_rate"],
        allocatable_profit=view["allocatable_profit"],
        totals_by_type=view["totals_by_type"],
        action_candidates=view["action_candidates"],
        form_rows=view["form_rows"],
    )


@router.get("/profit-allocation/company-settings", response_model=schemas.CompanyProfitSettingsOut)
def get_company_profit_settings(db: Annotated[Session, Depends(get_db)], user: CurrentUser = manage_access) -> schemas.CompanyProfitSettingsOut:
    del user
    settings = get_company_settings(db)
    return schemas.CompanyProfitSettingsOut(profit_rate=settings.profit_rate, loss_rate=settings.loss_rate)


@router.put("/profit-allocation/company-settings", response_model=schemas.CompanyProfitSettingsOut)
def set_company_profit_settings(payload: schemas.CompanyProfitSettingsIn, db: Annotated[Session, Depends(get_db)], user: CurrentUser = manage_access) -> schemas.CompanyProfitSettingsOut:
    settings = update_company_settings(db, CompanyProfitSettings(profit_rate=payload.profit_rate.quantize(Decimal("0.01")), loss_rate=payload.loss_rate.quantize(Decimal("0.01"))), actor=user.username)
    return schemas.CompanyProfitSettingsOut(profit_rate=settings.profit_rate, loss_rate=settings.loss_rate)


@router.get("/orders/{order_id}/profit-allocations", response_model=schemas.ProfitAllocationListOut)
def list_allocations(
    order_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = read_access,
) -> schemas.ProfitAllocationListOut:
    view = service.get_allocations_view(db, order_id, user=user)
    return _allocation_response(view)


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
    converted = service.convert_value(
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
    items = [item.model_dump() for item in payload.items]
    if payload.amounts_changed is not None:
        items = service.prepare_form_allocations(
            db, order_id, items=items, amounts_changed=payload.amounts_changed, user=user,
        )
    service.set_allocations(
        db,
        order_id,
        items=items,
        actor=user.username,
        form_extra=payload.form_extra,
        user=user,
    )
    view = service.get_allocations_view(db, order_id, user=user)
    return _allocation_response(view)


__all__ = ["router"]
