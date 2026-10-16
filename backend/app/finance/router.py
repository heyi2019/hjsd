"""finance.router：押金与返点 API（FIN-04 / REB-01）。

押金与返点均**不在列表内直接过账**：缴纳/释放/结算都走独立写接口并产生现金流。
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_DEPOSIT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_EVENT_POST,
    CurrentUser,
    require_permissions,
)
from app.finance import schemas, service

router = APIRouter(tags=["FIN-04/REB-01 押金与返点"])

read_access = require_permissions(PERM_FINANCE_READ, PERM_ORDER_CREATE, require_all=False)
post_deposit = require_permissions(PERM_DEPOSIT_POST)
post_rebate = require_permissions(PERM_ORDER_EVENT_POST)


def _actor(user: CurrentUser) -> str:
    return user.username


@router.get("/cashflows", response_model=list[schemas.CashflowOut])
def list_cashflows(
    pool_id: int | None = Query(default=None),
    order_id: int | None = Query(default=None),
    direction: str | None = Query(default=None),
    occurred_from: date | None = Query(default=None),
    occurred_to: date | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> list[schemas.CashflowOut]:
    if pool_id is not None and not user.can_see_pool(pool_id):
        return []
    if pool_id is None and not (user.is_admin or user.owner_scope == "ALL"):
        if not user.pool_ids:
            return []
        rows: list[dict] = []
        for allowed_pool_id in sorted(user.pool_ids):
            rows.extend(
                service.list_cashflows(
                    db,
                    pool_id=allowed_pool_id,
                    order_id=order_id,
                    direction=direction,
                    occurred_from=occurred_from,
                    occurred_to=occurred_to,
                    limit=limit,
                    offset=offset,
                )
            )
        rows.sort(key=lambda item: (item["occurred_on"], item["id"]), reverse=True)
        return [schemas.CashflowOut.model_validate(item) for item in rows[offset : offset + limit]]

    items = service.list_cashflows(
        db,
        pool_id=pool_id,
        order_id=order_id,
        direction=direction,
        occurred_from=occurred_from,
        occurred_to=occurred_to,
        limit=limit,
        offset=offset,
    )
    return [schemas.CashflowOut.model_validate(item) for item in items]


# --------------------------------------------------------------------- 押金
@router.get("/deposits", response_model=list[schemas.DepositOut])
def list_deposits(
    pool_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> list[schemas.DepositOut]:
    items = service.list_deposits(db, pool_id=pool_id)
    return [schemas.DepositOut.model_validate(item) for item in items]


@router.post("/deposits", response_model=schemas.DepositOut, status_code=201)
def create_deposit(
    payload: schemas.DepositCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.DepositOut:
    item = service.create_deposit(
        db,
        pool_id=payload.pool_id,
        amount=payload.amount,
        paid_on=payload.paid_on,
        actor=_actor(user),
        counterparty_id=payload.counterparty_id,
        source_order_id=payload.source_order_id,
        expected_release_on=payload.expected_release_on,
        note=payload.note,
    )
    return schemas.DepositOut.model_validate(item)


@router.post("/deposits/{deposit_id}/returns", response_model=schemas.DepositOut)
def return_deposit(
    deposit_id: int,
    payload: schemas.DepositReturn,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.DepositOut:
    item = service.return_deposit(
        db,
        deposit_id,
        amount=payload.amount,
        released_on=payload.released_on,
        actor=_actor(user),
    )
    return schemas.DepositOut.model_validate(item)


# --------------------------------------------------------------------- 返点
@router.get("/rebates", response_model=list[schemas.RebateOut])
def list_rebates(
    source_order_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> list[schemas.RebateOut]:
    items = service.list_rebates(db, source_order_id=source_order_id)
    return [schemas.RebateOut.model_validate(item) for item in items]


@router.post("/rebates", response_model=schemas.RebateOut, status_code=201)
def create_rebate(
    payload: schemas.RebateCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_rebate,
) -> schemas.RebateOut:
    item = service.create_rebate(
        db,
        source_order_id=payload.source_order_id,
        base_amount=payload.base_amount,
        collected_on=payload.collected_on,
        actor=_actor(user),
        rate=payload.rate,
        channel=payload.channel,
        note=payload.note,
    )
    return schemas.RebateOut.model_validate(item)


@router.post(
    "/rebates/{rebate_id}/settlements", response_model=schemas.SettlementOut, status_code=201
)
def settle_rebate(
    rebate_id: int,
    payload: schemas.SettlementCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_rebate,
) -> schemas.SettlementOut:
    item = service.settle_rebate(
        db,
        rebate_id,
        gross_amount=payload.gross_amount,
        settled_on=payload.settled_on,
        pool_id=payload.pool_id,
        actor=_actor(user),
        platform_fee=payload.platform_fee,
        note=payload.note,
    )
    return schemas.SettlementOut.model_validate(item)


__all__ = ["router"]
