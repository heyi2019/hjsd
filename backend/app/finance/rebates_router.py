"""返点登记与查询 API。"""
from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.database import get_db
from app.core.security import (
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_EVENT_POST,
    CurrentUser,
    require_permissions,
)
from app.domain.enums import AuditAction
from app.finance import schemas
from app.finance.rebates import (
    create_rebate as finance_create_rebate,
    get_rebate as finance_get_rebate,
    list_rebates as finance_list_rebates,
    update_rebate as finance_update_rebate,
)
from app.lists.export import build_list_csv
from app.lists.file_response import CSV_MEDIA_TYPE, file_response
from app.orders._shared import get_order

from .router_output import _actor, _rebate_out

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


@router.get("/rebates/export.csv")
def export_rebates_csv(
    source_order_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> Response:
    """返点按可见列导出 CSV，沿用 /rebates 的权限口径。"""
    outputs = list_rebates(source_order_id=source_order_id, db=db, _user=_user)
    rows = [output.model_dump() for output in outputs]
    csv_text, meta = build_list_csv(db, "REBATE", rows)
    record_audit(
        db,
        action=AuditAction.LIST_EXPORT,
        entity_type="list_export",
        entity_id="REBATE",
        actor=_user.username,
        after={"rows": len(rows), "column_count": meta["column_count"]},
    )
    return file_response(csv_text, f"返点-{date.today().isoformat()}.csv", CSV_MEDIA_TYPE)


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
