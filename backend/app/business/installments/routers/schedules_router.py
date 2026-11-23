"""installments.router：分期合约、收款、交付与逾期标记（HS-01-06）。"""
from __future__ import annotations


from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.database import get_db
from app.core.errors import Conflict, NotFound, Validation
from app.core.security import (
    PERM_FINANCE_ORDER_EVENT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_UPDATE,
    PERM_ORDER_EVENT_POST,
    CurrentUser,
)
from app.settings.auth.session import (
    require_permissions,
)
from app.domain.enums import AuditAction, CashflowSourceType
from app.domain.trade import Cashflow, InstallmentSchedule
from app.business.installments import schemas
from app.business.installments import _shared as inst__shared
from app.business.installments.repayments.waive import waive_schedule as inst_waive
from app.business.installments.repayments.extend import extend_schedule as inst_extend
from app.core.actor import actor_name as _actor
from app.shared.operation_operators import (
    get_operation_operators,
    upsert_operation_operators,
)


router = APIRouter(tags=["HS-01 分期合约"])

read_access = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
manage = require_permissions(PERM_ORDER_CREATE)
post_payment = require_permissions(
    PERM_ORDER_EVENT_POST, PERM_FINANCE_ORDER_EVENT_POST, require_all=False
)
post_delivery = require_permissions(PERM_ORDER_EVENT_POST)
default_manage = require_permissions(PERM_ORDER_UPDATE)

from ._router_shared import _installment_output, _schedule_output

@router.put(
    "/installments/{installment_id}/operation-operators/{operation_key}",
    response_model=schemas.InstallmentOut,
)
def update_installment_operation_operators(
    installment_id: int,
    operation_key: str,
    payload: schemas.OperationOperatorsUpdateIn,
    db: Session = Depends(get_db),
    user: CurrentUser = default_manage,
) -> schemas.InstallmentOut:
    """详情页只更新动作操作人，不改建单人和动作发生时间。"""
    # 与同一合约的收款及其他操作人修改串行，避免并发覆盖及错误审计前值。
    item = inst__shared.get_installment(db, installment_id, user, for_update=True)
    existing = get_operation_operators(
        db,
        entity_type="installment",
        entity_id=item.inst_no,
        operation_key=operation_key,
    )
    if existing is None:
        raise NotFound("业务动作操作人记录不存在")
    parts = operation_key.split(":")
    flow = None
    if parts[0] == "PAY":
        if len(parts) != 3:
            raise Validation("历史收款汇总无法定位单笔流水，不能修改操作人")
        flow = db.scalar(select(Cashflow).where(
            Cashflow.flow_no == parts[2], Cashflow.source_type == CashflowSourceType.INSTALLMENT.value,
            Cashflow.source_id == item.inst_no, Cashflow.order_id == item.order_id,
        ).with_for_update())
        if flow is None:
            raise Conflict("关联的收款流水不存在，不能修改操作人")
        if not user.can_see_pool(flow.pool_id):
            raise NotFound("收款流水不存在")
    before = list(existing.operator_user_ids)
    upsert_operation_operators(
        db,
        entity_type="installment",
        entity_id=item.inst_no,
        operation_key=operation_key,
        actor=_actor(user),
        operator_user_ids=payload.operator_user_ids,
        occurred_at=existing.occurred_at,
    )
    if flow is not None:
        flow.operator_user_ids = list(payload.operator_user_ids)
        flow.updated_by = _actor(user)
    record_audit(
        db,
        action=AuditAction.ORDER_UPDATE,
        entity_type="installment_operation_operators",
        entity_id=f"{item.inst_no}:{operation_key}",
        actor=_actor(user),
        before={"operator_user_ids": before},
        after={"operator_user_ids": payload.operator_user_ids},
    )
    return _installment_output(db, item)

@router.get("/installments/{installment_id}/schedules", response_model=list[schemas.ScheduleOut])
def list_schedules(
    installment_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> list[schemas.ScheduleOut]:
    installment = inst__shared.get_installment(db, installment_id, _user)
    rows = db.scalars(
        select(InstallmentSchedule)
        .where(InstallmentSchedule.installment_id == installment_id)
        .order_by(InstallmentSchedule.period_no)
    ).all()
    return [_schedule_output(row, installment.status) for row in rows]

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
    item = inst_waive(
        db,
        installment_id,
        period_no=period_no,
        amount=payload.amount,
        waived_on=payload.waived_on,
        actor=_actor(user),
        reason=payload.reason,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    installment = inst__shared.get_installment(db, installment_id, user)
    return _schedule_output(item, installment.status)

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
    item = inst_extend(
        db,
        installment_id,
        period_no=period_no,
        new_due_on=payload.new_due_on,
        actor=_actor(user),
        reason=payload.reason,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    installment = inst__shared.get_installment(db, installment_id, user)
    return _schedule_output(item, installment.status)

__all__ = ["router"]
