"""商户押金 API。"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import NotFound
from app.core.security import (
    PERM_DEPOSIT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    CurrentUser,
    require_permissions,
)
from app.domain.trade import Deposit
from app.finance import schemas
from app.finance.deposits import (
    cancel_deposit as finance_cancel_deposit,
    create_deposit as finance_create_deposit,
    delete_deposit as finance_delete_deposit,
    list_deposits as finance_list_deposits,
    lose_deposit as finance_lose_deposit,
    return_deposit as finance_return_deposit,
    update_deposit as finance_update_deposit,
)

from .router_output import _actor, _cashflow_out, _deposit_out

router = APIRouter(tags=["商户押金"])
read_access = require_permissions(PERM_FINANCE_READ, PERM_ORDER_CREATE, require_all=False)
post_deposit = require_permissions(PERM_DEPOSIT_POST)

@router.get("/deposits", response_model=list[schemas.DepositOut])
def list_deposits(
    pool_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> list[schemas.DepositOut]:
    if pool_id is not None and not user.can_see_pool(pool_id):
        return []
    items = finance_list_deposits(
        db,
        pool_id=pool_id,
        pool_ids=None
        if pool_id is not None or user.is_admin or user.owner_scope == "ALL"
        else sorted(user.pool_ids),
        user=user,
    )
    return [_deposit_out(item) for item in items]


@router.post("/deposits", response_model=schemas.DepositOut, status_code=201)
def create_deposit(
    payload: schemas.DepositCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.DepositOut:
    if not user.can_see_pool(payload.pool_id):
        raise NotFound("资金池不存在", details={"pool_id": payload.pool_id})
    item = finance_create_deposit(
        db,
        pool_id=payload.pool_id,
        amount=payload.amount,
        paid_on=payload.paid_on,
        actor=_actor(user),
        counterparty_id=payload.counterparty_id,
        source_order_id=payload.source_order_id,
        expected_release_on=payload.expected_release_on,
        note=payload.note,
        form_extra=payload.form_extra,
        user=user,
    )
    return _deposit_out(item)


@router.put("/deposits/{deposit_id}", response_model=schemas.DepositOut)
def update_deposit(
    deposit_id: int,
    payload: schemas.DepositUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.DepositOut:
    item = finance_update_deposit(
        db,
        deposit_id,
        pool_id=payload.pool_id,
        amount=payload.amount,
        paid_on=payload.paid_on,
        actor=_actor(user),
        counterparty_id=payload.counterparty_id,
        source_order_id=payload.source_order_id,
        expected_release_on=payload.expected_release_on,
        note=payload.note,
        form_extra=payload.form_extra,
        user=user,
    )
    return _deposit_out(item)


@router.delete("/deposits/{deposit_id}", status_code=204, response_model=None)
def delete_deposit(
    deposit_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> None:
    finance_delete_deposit(db, deposit_id, actor=_actor(user), user=user)


@router.post("/deposits/{deposit_id}/returns", response_model=schemas.DepositOut)
def return_deposit(
    deposit_id: int,
    payload: schemas.DepositReturn,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.DepositOut:
    deposit = db.get(Deposit, deposit_id)
    if deposit is None or not user.can_see_pool(deposit.pool_id):
        raise NotFound("押金不存在", details={"deposit_id": deposit_id})
    item = finance_return_deposit(
        db,
        deposit_id,
        amount=payload.amount,
        released_on=payload.released_on,
        form_extra=payload.form_extra,
        actor=_actor(user),
        user=user,
    )
    return _deposit_out(item)


@router.post("/deposits/{deposit_id}/cancel", response_model=schemas.DepositOut)
def cancel_deposit(
    deposit_id: int,
    payload: schemas.DepositCancel,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.DepositOut:
    """取消押金：仅未发生退还/损失的 PAID 押金；全额写 DEPOSIT_CANCEL 冲正流水。"""
    deposit = db.get(Deposit, deposit_id)
    if deposit is None or not user.can_see_pool(deposit.pool_id):
        raise NotFound("押金不存在", details={"deposit_id": deposit_id})
    item = finance_cancel_deposit(
        db,
        deposit_id,
        cancelled_on=payload.cancelled_on,
        reason=payload.reason,
        form_extra=payload.form_extra,
        actor=_actor(user),
        user=user,
    )
    return _deposit_out(item)


@router.post("/deposits/{deposit_id}/losses", response_model=schemas.CashflowOut)
def lose_deposit(
    deposit_id: int,
    payload: schemas.DepositLoss,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.CashflowOut:
    deposit = db.get(Deposit, deposit_id)
    if deposit is None or not user.can_see_pool(deposit.pool_id):
        raise NotFound("押金不存在", details={"deposit_id": deposit_id})
    flow = finance_lose_deposit(
        db,
        deposit_id,
        amount=payload.amount,
        lost_on=payload.lost_on,
        category=payload.category,
        reason=payload.reason,
        form_extra=payload.form_extra,
        actor=_actor(user),
        user=user,
    )
    return _cashflow_out(db, flow)


# --------------------------------------------------------------------- 返点
