"""installments.router：分期合约、收款、交付与逾期标记（HS-01-06 / DFQ-01）。"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_FINANCE_ORDER_EVENT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_EXCEPTION_APPROVE,
    PERM_ORDER_EVENT_POST,
    CurrentUser,
    require_permissions,
)
from app.domain.trade import InstallmentSchedule
from app.installments import schemas, service
from app.parties import service as parties_service

router = APIRouter(tags=["HS-01/DFQ-01 分期合约"])

read_access = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
manage = require_permissions(PERM_ORDER_CREATE)
post_payment = require_permissions(
    PERM_ORDER_EVENT_POST, PERM_FINANCE_ORDER_EVENT_POST, require_all=False
)
post_delivery = require_permissions(PERM_ORDER_EVENT_POST)
default_manage = require_permissions(PERM_ORDER_EXCEPTION_APPROVE)


def _actor(user: CurrentUser) -> str:
    return user.username


def _installment_output(db: Session, item) -> schemas.InstallmentOut:
    output = schemas.InstallmentOut.model_validate(item)
    output.extra_values = parties_service.get_extra_values(
        db, entity_type="installment", entity_id=item.id
    )
    return output


@router.get("/installments", response_model=list[schemas.InstallmentOut])
def list_installments(
    status: str | None = Query(default=None),
    order_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> list[schemas.InstallmentOut]:
    items = service.list_installments(db, status=status, order_id=order_id, user=_user)
    extras = parties_service.get_extra_values_bulk(
        db, entity_type="installment", entity_ids=[item.id for item in items]
    )
    return [
        schemas.InstallmentOut.model_validate({**item.__dict__, "extra_values": extras.get(item.id, {})})
        for item in items
    ]


@router.post("/installments", response_model=schemas.InstallmentOut, status_code=201)
def create_installment(
    payload: schemas.InstallmentCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage,
) -> schemas.InstallmentOut:
    item = service.create_installment(
        db,
        order_id=payload.order_id,
        contract_type=payload.contract_type,
        principal=payload.principal,
        down_payment=payload.down_payment,
        service_fee=payload.service_fee,
        periods=payload.periods,
        per_period_service_fee=payload.per_period_service_fee,
        per_period=payload.per_period,
        first_due_on=payload.first_due_on,
        actor=_actor(user),
        user=user,
        delivery_mode=payload.delivery_mode,
        note=payload.note,
        schedule=[item.model_dump() for item in payload.schedule] if payload.schedule else None,
        extra_values=payload.extra_values,
    )
    return _installment_output(db, item)


@router.get("/installments/{installment_id}/schedules", response_model=list[schemas.ScheduleOut])
def list_schedules(
    installment_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> list[schemas.ScheduleOut]:
    service.get_installment(db, installment_id, _user)
    rows = db.scalars(
        select(InstallmentSchedule)
        .where(InstallmentSchedule.installment_id == installment_id)
        .order_by(InstallmentSchedule.period_no)
    ).all()
    return [schemas.ScheduleOut.model_validate(row) for row in rows]


@router.post(
    "/installments/{installment_id}/schedules/{period_no}/waive",
    response_model=schemas.ScheduleOut,
)
def waive_schedule(
    installment_id: int,
    period_no: int,
    payload: schemas.ScheduleWaiveIn,
    db: Session = Depends(get_db),
    user: CurrentUser = default_manage,
) -> schemas.ScheduleOut:
    item = service.waive_schedule(
        db,
        installment_id,
        period_no=period_no,
        amount=payload.amount,
        waived_on=payload.waived_on,
        actor=_actor(user),
        reason=payload.reason,
        user=user,
    )
    return schemas.ScheduleOut.model_validate(item)


@router.post(
    "/installments/{installment_id}/schedules/{period_no}/extend",
    response_model=schemas.ScheduleOut,
)
def extend_schedule(
    installment_id: int,
    period_no: int,
    payload: schemas.ScheduleExtendIn,
    db: Session = Depends(get_db),
    user: CurrentUser = default_manage,
) -> schemas.ScheduleOut:
    item = service.extend_schedule(
        db,
        installment_id,
        period_no=period_no,
        new_due_on=payload.new_due_on,
        actor=_actor(user),
        reason=payload.reason,
        user=user,
    )
    return schemas.ScheduleOut.model_validate(item)


@router.post(
    "/installments/{installment_id}/payments", response_model=schemas.PaymentResult
)
def pay_installment(
    installment_id: int,
    payload: schemas.PaymentIn,
    db: Session = Depends(get_db),
    user: CurrentUser = post_payment,
) -> schemas.PaymentResult:
    installment, schedule = service.pay(
        db,
        installment_id,
        amount=payload.amount,
        paid_on=payload.paid_on,
        period_no=payload.period_no,
        actor=_actor(user),
        pool_id=payload.pool_id,
        note=payload.note,
        user=user,
    )
    return schemas.PaymentResult(
        installment=_installment_output(db, installment),
        schedule=schemas.ScheduleOut.model_validate(schedule),
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
    item = service.settle_early(
        db,
        installment_id,
        paid_on=payload.paid_on,
        pool_id=payload.pool_id,
        note=payload.note,
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
    item = service.mark_default(
        db,
        installment_id,
        actor=_actor(user),
        reason=payload.reason,
        user=user,
    )
    return _installment_output(db, item)


@router.post(
    "/installments/{installment_id}/deliver", response_model=schemas.InstallmentOut
)
def deliver_installment(
    installment_id: int,
    payload: schemas.DeliverIn,
    db: Session = Depends(get_db),
    user: CurrentUser = post_delivery,
) -> schemas.InstallmentOut:
    item = service.deliver(
        db,
        installment_id,
        delivery_mode=payload.delivery_mode,
        delivered_on=payload.delivered_on,
        note=payload.note,
        actor=_actor(user),
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
        marked=service.mark_overdue(db, as_of=as_of, actor=_actor(user), user=user)
    )


__all__ = ["router"]
