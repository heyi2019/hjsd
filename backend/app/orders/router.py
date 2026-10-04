"""orders.router：订单、事件、划转与资金池余额 API（ORD-01/02、FIN-01/03）。

金额类动作全部走 Service 事务；列表页只提供查询，不做直接过账。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_FINANCE_READ,
    PERM_FINANCE_TRANSFER,
    PERM_ORDER_CREATE,
    PERM_ORDER_EVENT_POST,
    PERM_ORDER_UPDATE,
    CurrentUser,
    require_permissions,
)
from app.orders import schemas, service

router = APIRouter(tags=["ORD-01/02 订单与事件"])

read_orders = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
create_orders = require_permissions(PERM_ORDER_CREATE)
post_events = require_permissions(PERM_ORDER_EVENT_POST)
update_orders = require_permissions(PERM_ORDER_UPDATE)
do_transfer = require_permissions(PERM_FINANCE_TRANSFER)
read_finance = require_permissions(PERM_FINANCE_READ)


def _actor(user: CurrentUser) -> str:
    return user.username


@router.get("/orders", response_model=list[schemas.OrderOut])
def list_orders(
    order_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_orders,
) -> list[schemas.OrderOut]:
    orders = service.list_orders(db, order_type=order_type, status=status)
    return [schemas.OrderOut.model_validate(item) for item in orders]


@router.post("/orders", response_model=schemas.OrderOut, status_code=201)
def create_order(
    payload: schemas.OrderCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = create_orders,
) -> schemas.OrderOut:
    order = service.create_order(
        db,
        order_type=payload.order_type.strip().upper(),
        trade_date=payload.trade_date,
        actor=_actor(user),
        account_id=payload.account_id,
        owner_id=payload.owner_id,
        capital_type=payload.capital_type,
        note=payload.note,
        customer_roles=[
            (role.customer_id, role.role)
            for role in payload.customer_roles
            if role.customer_id is not None
        ],
        counterparty_roles=[
            (role.counterparty_id, role.role)
            for role in payload.counterparty_roles
            if role.counterparty_id is not None
        ],
    )
    return schemas.OrderOut.model_validate(order)


@router.get("/orders/{order_id}", response_model=schemas.OrderOut)
def get_order(
    order_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_orders,
) -> schemas.OrderOut:
    return schemas.OrderOut.model_validate(service.get_order(db, order_id))


@router.post("/orders/{order_id}/events", response_model=schemas.EventPostResult, status_code=201)
def post_event(
    order_id: int,
    payload: schemas.EventCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_events,
) -> dict:
    event, flow = service.post_event(
        db,
        order_id,
        event_type=payload.event_type.strip().upper(),
        amount=payload.amount,
        occurred_on=payload.occurred_on,
        actor=_actor(user),
        pool_id=payload.pool_id,
        portion=payload.portion,
        delivery_mode=payload.delivery_mode,
        offset_event_id=payload.offset_event_id,
        reason=payload.reason,
        note=payload.note,
    )
    return {
        "event": schemas.EventOut.model_validate(event),
        "cashflow_no": flow.flow_no if flow else None,
    }


@router.post("/transfers", response_model=schemas.TransferOut, status_code=201)
def create_transfer(
    payload: schemas.TransferCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = do_transfer,
) -> dict:
    out_flow, in_flow = service.transfer(
        db,
        source_pool_id=payload.source_pool_id,
        target_pool_id=payload.target_pool_id,
        amount=payload.amount,
        occurred_on=payload.occurred_on,
        actor=_actor(user),
        note=payload.note,
    )
    return {
        "transfer_id": out_flow.transfer_id,
        "out_flow_no": out_flow.flow_no,
        "in_flow_no": in_flow.flow_no,
        "amount": out_flow.amount,
    }


@router.get("/pools/{pool_id}/balance", response_model=schemas.PoolBalanceOut)
def pool_balance(
    pool_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_finance,
) -> dict:
    return service.pool_balance(db, pool_id)


__all__ = ["router"]
