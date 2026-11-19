"""installments.router：分期合约、收款、交付与逾期标记（HS-01-06）。"""
from __future__ import annotations


from fastapi import APIRouter, Depends
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
from app.finance.installments import schemas
from app.finance.installments.repayments.pay import pay as inst_pay
from app.finance.installments.repayments.cancel import cancel_installment as inst_cancel
from app.finance.installments import settlement as inst_settlement
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
    "/installments/{installment_id}/payments", response_model=schemas.PaymentResult
)
def pay_installment(
    installment_id: int,
    payload: schemas.PaymentIn,
    db: Session = Depends(get_db),
    user: CurrentUser = post_payment,
) -> schemas.PaymentResult:
    installment, schedule = inst_pay(
        db,
        installment_id,
        amount=payload.amount,
        paid_on=payload.paid_on,
        period_no=payload.period_no,
        actor=_actor(user),
        pool_id=payload.pool_id,
        note=payload.note,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return schemas.PaymentResult(
        installment=_installment_output(db, installment),
        schedule=schemas.ScheduleOut.model_validate(schedule),
    )

@router.post(
    "/installments/{installment_id}/cancel",
    response_model=schemas.InstallmentCancelResult,
)
def cancel_installment(
    installment_id: int,
    payload: schemas.CancelIn,
    db: Session = Depends(get_db),
    user: CurrentUser = post_payment,
) -> schemas.InstallmentCancelResult:
    result = inst_cancel(
        db,
        installment_id,
        cancelled_on=payload.cancelled_on,
        actor=_actor(user),
        reason=payload.reason,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return schemas.InstallmentCancelResult(
        installment=_installment_output(db, result["installment"]),
        order_status=result["order_status"],
        account_status=result["account_status"],
        refund_amount=result["refund_amount"],
        reversed_amount=result["reversed_amount"],
        cancel_event_ids=result["cancel_event_ids"],
    )

@router.post(
    "/installments/{installment_id}/settle-early", response_model=schemas.InstallmentOut
)
def settle_early_installment(
    installment_id: int,
    payload: schemas.EarlySettlementIn,
    db: Session = Depends(get_db),
    user: CurrentUser = post_payment,
) -> schemas.InstallmentOut:
    item = inst_settlement.settle_early(
        db,
        installment_id,
        paid_on=payload.paid_on,
        pool_id=payload.pool_id,
        note=payload.note,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        actor=_actor(user),
        user=user,
    )
    return _installment_output(db, item)

@router.post(
    "/installments/{installment_id}/default", response_model=schemas.InstallmentOut
)
def default_installment(
    installment_id: int,
    payload: schemas.DefaultIn,
    db: Session = Depends(get_db),
    user: CurrentUser = default_manage,
) -> schemas.InstallmentOut:
    item = inst_settlement.mark_default(
        db,
        installment_id,
        actor=_actor(user),
        reason=payload.reason,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return _installment_output(db, item)

__all__ = ["router"]
