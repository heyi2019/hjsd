"""finance.router：押金与返点 API（FIN-04 / REB-01）。

押金与返点均**不在列表内直接登记**：缴纳/释放/结算都走独立写接口并产生现金流。
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import NotFound
from app.core.security import (
    PERM_DEPOSIT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_EVENT_POST,
    PERM_PERIOD_LOCK,
    PERM_POOL_MANAGE,
    PERM_TRANSFER_POST,
    CurrentUser,
    require_permissions,
)
from app.finance import schemas, service
from app.domain.trade import Deposit, Order, RebateRecord
from app.orders import service as orders_service
from app.parties import service as parties_service

router = APIRouter(tags=["FIN-04/REB-01 押金与返点"])

read_access = require_permissions(PERM_FINANCE_READ, PERM_ORDER_CREATE, require_all=False)
read_period_locks = require_permissions(PERM_FINANCE_READ)
manage_period_locks = require_permissions(PERM_PERIOD_LOCK)
post_deposit = require_permissions(PERM_DEPOSIT_POST)
post_rebate = require_permissions(PERM_ORDER_EVENT_POST)
post_transfer = require_permissions(PERM_TRANSFER_POST)
manage_pool_accounts = require_permissions(PERM_POOL_MANAGE)


def _actor(user: CurrentUser) -> str:
    return user.username


def _pool_account_out(db: Session, row) -> schemas.PoolAccountOut:
    output = schemas.PoolAccountOut.model_validate(row)
    output.current_balance = service.pool_account_balance(db, row)
    return output


@router.get("/pool-accounts", response_model=list[schemas.PoolAccountOut])
def list_pool_accounts(
    pool_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> list[schemas.PoolAccountOut]:
    rows = service.list_pool_accounts(db, pool_id=pool_id)
    return [_pool_account_out(db, row) for row in rows if user.can_see_pool(row.pool_id)]


@router.post("/pool-accounts", response_model=schemas.PoolAccountOut, status_code=201)
def create_pool_account(
    payload: schemas.PoolAccountCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_pool_accounts,
) -> schemas.PoolAccountOut:
    row = service.create_pool_account(
        db,
        pool_id=payload.pool_id,
        account_no=payload.account_no,
        account_name=payload.account_name,
        account_type=payload.account_type.strip().upper(),
        ownership=payload.ownership.strip().upper(),
        opening_balance=payload.opening_balance,
        note=payload.note,
        actor=_actor(user),
    )
    return _pool_account_out(db, row)


@router.patch("/pool-accounts/{account_id}/status", response_model=schemas.PoolAccountOut)
def set_pool_account_status(
    account_id: int,
    status: str = Query(...),
    db: Session = Depends(get_db),
    user: CurrentUser = manage_pool_accounts,
) -> schemas.PoolAccountOut:
    row = service.set_pool_account_status(db, account_id, status=status.strip().upper(), actor=_actor(user))
    return _pool_account_out(db, row)


@router.post("/pool-accounts/batch-status", response_model=list[schemas.PoolAccountOut])
def batch_set_pool_account_status(
    payload: schemas.PoolAccountBatchStatus,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_pool_accounts,
) -> list[schemas.PoolAccountOut]:
    rows = service.batch_set_pool_account_status(
        db,
        payload.account_ids,
        status=payload.status.strip().upper(),
        reason=payload.reason,
        actor=_actor(user),
    )
    if any(not user.can_see_pool(row.pool_id) for row in rows):
        raise NotFound("资金账户不存在")
    return [_pool_account_out(db, row) for row in rows]


@router.get("/period-locks", response_model=list[schemas.PeriodLockOut])
def list_period_locks(
    db: Session = Depends(get_db),
    _user: CurrentUser = read_period_locks,
) -> list[schemas.PeriodLockOut]:
    return [
        schemas.PeriodLockOut.model_validate(item)
        for item in service.list_period_locks(db)
    ]


@router.post("/period-locks", response_model=schemas.PeriodLockOut, status_code=201)
def create_period_lock(
    payload: schemas.PeriodLockCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_period_locks,
) -> schemas.PeriodLockOut:
    item = service.create_period_lock(
        db, period=payload.period, note=payload.note, actor=_actor(user)
    )
    return schemas.PeriodLockOut.model_validate(item)


def _cashflow_out(db: Session, flow) -> schemas.CashflowOut:
    def value(key: str):
        if isinstance(flow, dict):
            return flow.get(key)
        if key == "occurred_at":
            return flow.created_at
        return getattr(flow, key)
    nature = value("nature")
    category = value("category")
    direction = value("direction")
    order_id = value("order_id")
    order_event_id = value("order_event_id")
    transfer_id = value("transfer_id")
    deposit_id = value("deposit_id")
    order = db.get(Order, order_id) if order_id else None
    if order_event_id is not None:
        source = "ORDER_EVENT"
    elif category in {"REBATE", "REBATE_REVERSAL"}:
        source = "REBATE_SETTLEMENT"
    elif deposit_id is not None or category in {
        "DEPOSIT_HOLD",
        "DEPOSIT_RELEASE",
        "DEPOSIT_LOSS",
    }:
        source = "DEPOSIT"
    elif category == "TRANSFER":
        source = "TRANSFER"
    else:
        source = "OTHER"
    return schemas.CashflowOut(
        id=value("id"),
        flow_no=value("flow_no"),
        pool_id=value("pool_id"),
        pool_account_id=value("pool_account_id"),
        occurred_on=value("occurred_on"),
        occurred_at=value("occurred_at"),
        nature=nature,
        fund_nature=value("fund_nature"),
        accounting_attribute=value("accounting_attribute"),
        category=category,
        direction=direction,
        amount=value("amount"),
        status=value("status"),
        reviewed_by=value("reviewed_by"),
        reviewed_at=value("reviewed_at"),
        reversal_of_id=value("reversal_of_id"),
        order_id=order_id,
        order_no=order.order_no if order else None,
        deposit_id=deposit_id,
        order_event_id=order_event_id,
        transfer_id=transfer_id,
        source=source,
        note=value("note"),
        operator=(value("operator") or value("created_by"))
        if isinstance(flow, dict)
        else flow.created_by,
        extra_values=parties_service.get_extra_values(
            db, entity_type="cashflow", entity_id=value("id")
        ),
    )


def _deposit_out(item: Deposit) -> schemas.DepositOut:
    return schemas.DepositOut.model_validate(
        {**vars(item), "created_at": item.created_at, "operator": item.created_by}
    )


def _rebate_out(item: RebateRecord) -> schemas.RebateOut:
    return schemas.RebateOut.model_validate(
        {**vars(item), "created_at": item.created_at, "operator": item.created_by}
    )


def _settlement_out(item) -> schemas.SettlementOut:
    return schemas.SettlementOut.model_validate(
        {**vars(item), "created_at": item.created_at, "operator": item.created_by}
    )


def _reconciliation_out(item) -> schemas.ReconciliationOut:
    return schemas.ReconciliationOut.model_validate(
        {**vars(item), "created_at": item.created_at, "operator": item.created_by}
    )


def _transfer_out(db: Session, result: dict) -> schemas.TransferOut:
    flows = result["cashflows"]
    first_flow = min(flows, key=lambda flow: flow.created_at)
    return schemas.TransferOut(
        transfer_id=result["transfer_id"],
        source_pool_id=result["source_pool_id"],
        target_pool_id=result["target_pool_id"],
        amount=result["amount"],
        occurred_on=result["occurred_on"],
        created_at=first_flow.created_at,
        operator=first_flow.created_by,
        cashflows=[_cashflow_out(db, flow) for flow in flows],
    )


@router.get("/cashflows", response_model=list[schemas.CashflowOut])
def list_cashflows(
    pool_id: int | None = Query(default=None),
    order_id: int | None = Query(default=None),
    direction: str | None = Query(default=None),
    occurred_from: date | None = Query(default=None),
    occurred_to: date | None = Query(default=None),
    status: str | None = Query(default=None),
    nature: str | None = Query(default=None),
    fund_nature: str | None = Query(default=None),
    accounting_attribute: str | None = Query(default=None),
    category: str | None = Query(default=None),
    created_by: str | None = Query(default=None),
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
        items = service.list_cashflows(
            db,
            pool_ids=sorted(user.pool_ids),
            order_id=order_id,
            direction=direction,
            occurred_from=occurred_from,
            occurred_to=occurred_to,
            status=status,
            nature=nature.strip().upper() if nature else None,
            fund_nature=fund_nature.strip().upper() if fund_nature else None,
            accounting_attribute=(
                accounting_attribute.strip().upper()
                if accounting_attribute else None
            ),
            category=category.strip().upper() if category else None,
            created_by=created_by,
            limit=limit,
            offset=offset,
            user=user,
        )
        return [_cashflow_out(db, item) for item in items]

    items = service.list_cashflows(
        db,
        pool_id=pool_id,
        order_id=order_id,
        direction=direction,
        occurred_from=occurred_from,
        occurred_to=occurred_to,
        status=status,
        nature=nature.strip().upper() if nature else None,
        fund_nature=fund_nature.strip().upper() if fund_nature else None,
        accounting_attribute=(
            accounting_attribute.strip().upper()
            if accounting_attribute else None
        ),
        category=category.strip().upper() if category else None,
        created_by=created_by,
        limit=limit,
        offset=offset,
        user=user,
    )
    return [_cashflow_out(db, item) for item in items]


@router.post("/cashflows", response_model=schemas.CashflowOut, status_code=201)
def create_cashflow(
    payload: schemas.CashflowCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.CashflowOut:
    flow = service.create_cashflow(
        db,
        pool_id=payload.pool_id,
        pool_account_id=payload.pool_account_id,
        occurred_on=payload.occurred_on,
        direction=payload.direction.strip().upper(),
        nature=payload.nature.strip().upper(),
        fund_nature=payload.fund_nature.strip().upper() if payload.fund_nature else None,
        accounting_attribute=(
            payload.accounting_attribute.strip().upper()
            if payload.accounting_attribute
            else None
        ),
        category=payload.category,
        amount=payload.amount,
        order_id=payload.order_id,
        note=payload.note,
        extra_values=payload.extra_values,
        actor=_actor(user),
        user=user,
    )
    return _cashflow_out(db, flow)


@router.post("/cashflows/{cashflow_id}/approve", response_model=schemas.CashflowOut)
def approve_cashflow(
    cashflow_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.CashflowOut:
    flow = service.approve_cashflow(db, cashflow_id, actor=_actor(user), user=user)
    return _cashflow_out(db, flow)


@router.post("/cashflows/{cashflow_id}/reject", response_model=schemas.CashflowOut)
def reject_cashflow(
    cashflow_id: int,
    payload: schemas.CashflowReject,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.CashflowOut:
    flow = service.reject_cashflow(
        db, cashflow_id, actor=_actor(user), reason=payload.reason, user=user
    )
    return _cashflow_out(db, flow)


@router.post("/cashflows/{cashflow_id}/reverse", response_model=schemas.CashflowOut)
def reverse_cashflow(
    cashflow_id: int,
    payload: schemas.CashflowReverse,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.CashflowOut:
    flow = service.reverse_cashflow(
        db,
        cashflow_id,
        reversed_on=payload.reversed_on,
        actor=_actor(user),
        reason=payload.reason,
        user=user,
    )
    return _cashflow_out(db, flow)


@router.get("/reconciliations", response_model=list[schemas.ReconciliationOut])
def list_reconciliations(
    pool_id: int | None = Query(default=None),
    pool_account_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> list[schemas.ReconciliationOut]:
    if pool_id is not None and not user.can_see_pool(pool_id):
        return []
    items = service.list_reconciliations(
        db,
        pool_id=pool_id,
        pool_account_id=pool_account_id,
        pool_ids=None
        if pool_id is not None or user.is_admin or user.owner_scope == "ALL"
        else sorted(user.pool_ids),
        user=user,
    )
    return [_reconciliation_out(item) for item in items]


@router.post("/reconciliations", response_model=schemas.ReconciliationOut, status_code=201)
def create_reconciliation(
    payload: schemas.ReconciliationCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.ReconciliationOut:
    if not user.can_see_pool(payload.pool_id):
        raise NotFound("资金池不存在", details={"pool_id": payload.pool_id})
    item = service.create_reconciliation(
        db,
        pool_id=payload.pool_id,
        pool_account_id=payload.pool_account_id,
        reconciled_on=payload.reconciled_on,
        account_label=payload.account_label,
        statement_balance=payload.statement_balance,
        unmatched_flow_ids=payload.unmatched_flow_ids,
        reason=payload.reason,
        note=payload.note,
        actor=_actor(user),
        user=user,
    )
    return _reconciliation_out(item)


@router.post(
    "/reconciliations/{reconciliation_id}/resolve",
    response_model=schemas.ReconciliationOut,
)
def resolve_reconciliation(
    reconciliation_id: int,
    payload: schemas.ReconciliationResolve,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.ReconciliationOut:
    item = service.resolve_reconciliation(
        db,
        reconciliation_id,
        actor=_actor(user),
        reason=payload.reason,
        user=user,
    )
    return _reconciliation_out(item)


@router.post("/transfers", response_model=schemas.TransferOut, status_code=201)
def create_transfer(
    payload: schemas.TransferCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_transfer,
) -> schemas.TransferOut:
    if not user.can_see_pool(payload.source_pool_id) or not user.can_see_pool(payload.target_pool_id):
        raise NotFound("资金池不存在", details={"pool_id": payload.source_pool_id})
    result = service.create_transfer(
        db,
        source_pool_id=payload.source_pool_id,
        target_pool_id=payload.target_pool_id,
        amount=payload.amount,
        occurred_on=payload.occurred_on,
        actor=_actor(user),
        note=payload.note,
        user=user,
    )
    return _transfer_out(db, result)


@router.post(
    "/transfers/{transfer_id}/repair",
    response_model=schemas.TransferOut,
)
def repair_transfer(
    transfer_id: str,
    payload: schemas.TransferRepair,
    db: Session = Depends(get_db),
    user: CurrentUser = post_transfer,
) -> schemas.TransferOut:
    if not user.can_see_pool(payload.counterpart_pool_id):
        raise NotFound("资金池不存在", details={"pool_id": payload.counterpart_pool_id})
    result = service.repair_transfer(
        db,
        transfer_id,
        counterpart_pool_id=payload.counterpart_pool_id,
        actor=_actor(user),
        reason=payload.reason,
        user=user,
    )
    return _transfer_out(db, result)


# --------------------------------------------------------------------- 押金
@router.get("/deposits", response_model=list[schemas.DepositOut])
def list_deposits(
    pool_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> list[schemas.DepositOut]:
    if pool_id is not None and not user.can_see_pool(pool_id):
        return []
    items = service.list_deposits(
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
        user=user,
    )
    return _deposit_out(item)


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
    item = service.return_deposit(
        db,
        deposit_id,
        amount=payload.amount,
        released_on=payload.released_on,
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
    flow = service.lose_deposit(
        db,
        deposit_id,
        amount=payload.amount,
        lost_on=payload.lost_on,
        category=payload.category,
        reason=payload.reason,
        actor=_actor(user),
        user=user,
    )
    return _cashflow_out(db, flow)


# --------------------------------------------------------------------- 返点
@router.get("/rebates", response_model=list[schemas.RebateOut])
def list_rebates(
    source_order_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> list[schemas.RebateOut]:
    items = service.list_rebates(db, source_order_id=source_order_id, user=_user)
    return [_rebate_out(item) for item in items]


@router.get("/rebates/overdue", response_model=list[schemas.RebateOverdueOut])
def list_overdue_rebates(
    as_of: date | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> list[schemas.RebateOverdueOut]:
    """返点预计到账日逾期清单，供通知任务和跟进台账使用。"""
    on = as_of or date.today()
    return [
        schemas.RebateOverdueOut.model_validate(
            {
                **vars(item),
                "created_at": item.created_at,
                "operator": item.created_by,
                "overdue_days": overdue_days,
            }
        )
        for item, overdue_days in service.list_overdue_rebates(db, as_of=on, user=user)
    ]


@router.get("/rebates/{rebate_id}", response_model=schemas.RebateOut)
def get_rebate(
    rebate_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> schemas.RebateOut:
    return _rebate_out(service.get_rebate(db, rebate_id, user=user))


@router.post("/rebates", response_model=schemas.RebateOut, status_code=201)
def create_rebate(
    payload: schemas.RebateCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_rebate,
) -> schemas.RebateOut:
    orders_service.get_order(db, payload.source_order_id, user)
    item = service.create_rebate(
        db,
        source_order_id=payload.source_order_id,
        rebate_type=payload.rebate_type,
        base_amount=payload.base_amount,
        collected_on=payload.collected_on,
        expected_on=payload.expected_on,
        actor=_actor(user),
        rate=payload.rate,
        channel=payload.channel,
        note=payload.note,
        user=user,
    )
    return _rebate_out(item)


@router.post(
    "/rebates/{rebate_id}/settlements", response_model=schemas.SettlementOut, status_code=201
)
def settle_rebate(
    rebate_id: int,
    payload: schemas.SettlementCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_rebate,
) -> schemas.SettlementOut:
    rebate = db.get(RebateRecord, rebate_id)
    if rebate is None:
        raise NotFound("返点记录不存在", details={"rebate_record_id": rebate_id})
    orders_service.get_order(db, rebate.source_order_id, user)
    item = service.settle_rebate(
        db,
        rebate_id,
        gross_amount=payload.gross_amount,
        settled_on=payload.settled_on,
        pool_id=payload.pool_id,
        actor=_actor(user),
        platform_fee=payload.platform_fee,
        note=payload.note,
        user=user,
    )
    return _settlement_out(item)


@router.get(
    "/rebates/{rebate_id}/settlements", response_model=list[schemas.SettlementOut]
)
def list_rebate_settlements(
    rebate_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> list[schemas.SettlementOut]:
    items = service.list_rebate_settlements(db, rebate_id, user=user)
    return [_settlement_out(item) for item in items]


@router.post(
    "/rebates/{rebate_id}/settlements/{settlement_id}/reverse",
    response_model=schemas.SettlementOut,
)
def reverse_rebate_settlement(
    rebate_id: int,
    settlement_id: int,
    payload: schemas.SettlementReverse,
    db: Session = Depends(get_db),
    user: CurrentUser = post_rebate,
) -> schemas.SettlementOut:
    item = service.reverse_rebate_settlement(
        db,
        rebate_id,
        settlement_id,
        reversed_on=payload.reversed_on,
        actor=_actor(user),
        reason=payload.reason,
        user=user,
    )
    return _settlement_out(item)


__all__ = ["router"]
