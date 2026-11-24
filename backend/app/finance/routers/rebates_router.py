"""返点登记与查询 API。"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_EVENT_POST,
    CurrentUser,
)
from app.settings.auth.session import (
    require_permissions,
)
from app.finance import schemas
from app.finance.rebates import (
    create_rebate as finance_create_rebate,
    get_rebate as finance_get_rebate,
    list_rebates as finance_list_rebates,
    update_rebate as finance_update_rebate,
)
from app.shared.order_access import get_order

from ..router_output import _actor, _rebate_out

router = APIRouter(tags=["返点"])
read_access = require_permissions(PERM_FINANCE_READ, PERM_ORDER_CREATE, require_all=False)
post_rebate = require_permissions(PERM_ORDER_EVENT_POST)

@router.get("/rebates", response_model=list[schemas.RebateOut])
def list_rebates(
    source_order_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> list[schemas.RebateOut]:
    items = finance_list_rebates(db, source_order_id=source_order_id, user=_user)
    return [_rebate_out(item) for item in items]


@router.get("/rebates/{rebate_id}", response_model=schemas.RebateOut)
def get_rebate(
    rebate_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> schemas.RebateOut:
    item = finance_get_rebate(db, rebate_id, user=user)
    return _rebate_out(item)


@router.post("/rebates", response_model=schemas.RebateOut, status_code=201)
def create_rebate(
    payload: schemas.RebateCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_rebate,
) -> schemas.RebateOut:
    get_order(db, payload.source_order_id, user)
    item = finance_create_rebate(
        db,
        source_order_id=payload.source_order_id,
        rebate_type=payload.rebate_type,
        amount=payload.amount,
        collected_on=payload.collected_on,
        actor=_actor(user),
        operator_user_ids=payload.operator_user_ids,
        channel=payload.channel,
        note=payload.note,
        form_extra=payload.form_extra,
        user=user,
    )
    return _rebate_out(item)


@router.patch("/rebates/{rebate_id}", response_model=schemas.RebateOut)
def update_rebate(
    rebate_id: int,
    payload: schemas.RebateUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_rebate,
) -> schemas.RebateOut:
    item = finance_update_rebate(db, rebate_id, actor=_actor(user), user=user, **payload.model_dump(exclude_unset=True))
    return _rebate_out(item)


__all__ = ["router"]
