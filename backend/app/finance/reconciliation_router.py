"""资金对账和划转 API。"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import NotFound
from app.core.security import (
    PERM_DEPOSIT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_TRANSFER_POST,
    CurrentUser,
)
from app.auth.session import (
    require_permissions,
)
from app.finance import schemas
from app.finance.reconciliation import (
    create_reconciliation as finance_create_reconciliation,
    list_balance_snapshots as finance_list_balance_snapshots,
    list_reconciliations as finance_list_reconciliations,
    resolve_reconciliation as finance_resolve_reconciliation,
)
from app.finance.transfers import (
    create_transfer as finance_create_transfer,
    repair_transfer as finance_repair_transfer,
)

from .router_output import _actor, _reconciliation_out, _transfer_out

router = APIRouter(tags=["资金对账与划转"])
read_access = require_permissions(PERM_FINANCE_READ, PERM_ORDER_CREATE, require_all=False)
post_deposit = require_permissions(PERM_DEPOSIT_POST)
post_transfer = require_permissions(PERM_TRANSFER_POST)

@router.get("/reconciliations", response_model=list[schemas.ReconciliationOut])
def list_reconciliations(
    pool_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> list[schemas.ReconciliationOut]:
    if pool_id is not None and not user.can_see_pool(pool_id):
        return []
    items = finance_list_reconciliations(
        db,
        pool_id=pool_id,
        pool_ids=None
        if pool_id is not None or user.is_admin or user.owner_scope == "ALL"
        else sorted(user.pool_ids),
        user=user,
    )
    return [_reconciliation_out(item, db) for item in items]


@router.get("/balance-snapshots", response_model=list[schemas.BalanceSnapshotOut])
def list_balance_snapshots(
    pool_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> list[schemas.BalanceSnapshotOut]:
    """FIN-01-05：查询随对账固化的日终余额快照（只读历史台账）。"""
    if pool_id is not None and not user.can_see_pool(pool_id):
        return []
    items = finance_list_balance_snapshots(db, pool_id=pool_id, user=user)
    return [schemas.BalanceSnapshotOut.model_validate(item) for item in items]


@router.post("/reconciliations", response_model=schemas.ReconciliationOut, status_code=201)
def create_reconciliation(
    payload: schemas.ReconciliationCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.ReconciliationOut:
    if not user.can_see_pool(payload.pool_id):
        raise NotFound("资金账户不存在", details={"pool_id": payload.pool_id})
    item = finance_create_reconciliation(
        db,
        pool_id=payload.pool_id,
        reconciled_on=payload.reconciled_on,
        account_label=payload.account_label,
        statement_balance=payload.statement_balance,
        unmatched_flow_ids=payload.unmatched_flow_ids,
        reason=payload.reason,
        note=payload.note,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        actor=_actor(user),
        user=user,
    )
    return _reconciliation_out(item, db)


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
    item = finance_resolve_reconciliation(
        db,
        reconciliation_id,
        actor=_actor(user),
        reason=payload.reason,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return _reconciliation_out(item, db)


@router.post("/transfers", response_model=schemas.TransferOut, status_code=201)
def create_transfer(
    payload: schemas.TransferCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_transfer,
) -> schemas.TransferOut:
    if not user.can_see_pool(payload.source_pool_id) or not user.can_see_pool(payload.target_pool_id):
        raise NotFound("资金账户不存在", details={"pool_id": payload.source_pool_id})
    result = finance_create_transfer(
        db,
        source_pool_id=payload.source_pool_id,
        target_pool_id=payload.target_pool_id,
        amount=payload.amount,
        occurred_on=payload.occurred_on,
        actor=_actor(user),
        note=payload.note,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
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
        raise NotFound("资金账户不存在", details={"pool_id": payload.counterpart_pool_id})
    result = finance_repair_transfer(
        db,
        transfer_id,
        counterpart_pool_id=payload.counterpart_pool_id,
        actor=_actor(user),
        reason=payload.reason,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return _transfer_out(db, result)


# --------------------------------------------------------------------- 押金
