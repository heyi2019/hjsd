"""installments.router：分期合约、收款、交付与逾期标记（HS-01-06）。"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_FINANCE_ORDER_EVENT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_UPDATE,
    PERM_ORDER_EVENT_POST,
    CurrentUser,
)
from app.auth.session import (
    require_permissions,
)
from app.installments import schemas
from app.installments import recovery as inst_recovery
from app.core.actor import actor_name as _actor


router = APIRouter(tags=["HS-01 分期合约"])

read_access = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
manage = require_permissions(PERM_ORDER_CREATE)
post_payment = require_permissions(
    PERM_ORDER_EVENT_POST, PERM_FINANCE_ORDER_EVENT_POST, require_all=False
)
post_delivery = require_permissions(PERM_ORDER_EVENT_POST)
default_manage = require_permissions(PERM_ORDER_UPDATE)

from ._router_shared import _installment_output

@router.post(
    "/installments/{installment_id}/recover",
    response_model=schemas.DispositionOut,
)
def recover_installment_account(
    installment_id: int,
    payload: schemas.DispositionIn,
    db: Session = Depends(get_db),
    user: CurrentUser = default_manage,
) -> schemas.DispositionOut:
    item = inst_recovery.recover_account(
        db,
        installment_id,
        occurred_on=payload.occurred_on,
        actor=_actor(user),
        note=payload.note,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return schemas.DispositionOut.model_validate(item)

@router.get(
    "/installments/{installment_id}/dispositions",
    response_model=list[schemas.DispositionOut],
)
def list_installment_dispositions(
    installment_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> list[schemas.DispositionOut]:
    return [
        schemas.DispositionOut.model_validate(item)
        for item in inst_recovery.list_dispositions(db, installment_id, user)
    ]

@router.post(
    "/installments/{installment_id}/resale",
    response_model=schemas.DispositionOut,
)
def resale_installment_account(
    installment_id: int,
    payload: schemas.ResaleIn,
    db: Session = Depends(get_db),
    user: CurrentUser = default_manage,
) -> schemas.DispositionOut:
    item = inst_recovery.record_sale(
        db,
        installment_id,
        sale_order_id=payload.resale_order_id,
        occurred_on=payload.occurred_on,
        actor=_actor(user),
        note=payload.note,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return schemas.DispositionOut.model_validate(item)

@router.post(
    "/installments/{installment_id}/deliver", response_model=schemas.InstallmentOut
)
def deliver_installment(
    installment_id: int,
    payload: schemas.DeliverIn,
    db: Session = Depends(get_db),
    user: CurrentUser = post_delivery,
) -> schemas.InstallmentOut:
    item = inst_recovery.deliver(
        db,
        installment_id,
        delivery_mode=payload.delivery_mode,
        delivered_on=payload.delivered_on,
        note=payload.note,
        bound_phone=payload.bound_phone,
        bound_phone_owner=payload.bound_phone_owner,
        form_extra=payload.form_extra,
        actor=_actor(user),
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return _installment_output(db, item)

@router.post(
    "/installments/mark-overdue",
    response_model=schemas.MarkOverdueOut,
    status_code=200,
)
def mark_overdue(
    as_of: date = Query(default_factory=date.today),
    db: Session = Depends(get_db),
    user: CurrentUser = post_delivery,
) -> schemas.MarkOverdueOut:
    return schemas.MarkOverdueOut(
        marked=inst_recovery.mark_overdue(db, as_of=as_of, actor=_actor(user), user=user)
    )

__all__ = ["router"]
