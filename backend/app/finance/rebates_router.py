"""返点登记、查询和退回 API。"""
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
    rebate_returned_totals,
    return_rebate as finance_return_rebate,
    update_rebate as finance_update_rebate,
)
from app.lists.export import build_list_csv
from app.lists.file_response import CSV_MEDIA_TYPE, file_response
from app.orders._shared import get_order

from .router_output import _actor, _cashflow_out, _rebate_out

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
    # 已退金额一次批量聚合（order_id IN），避免逐笔子查询；列表口径与单查/退回同源。
    returned = rebate_returned_totals(db, items)
    return [_rebate_out(item, returned[item.id]) for item in items]


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
    return _rebate_out(item, rebate_returned_totals(db, [item])[item.id])


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
        rate=payload.rate,
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
    return _rebate_out(item, rebate_returned_totals(db, [item])[item.id])


@router.post("/rebates/{rebate_id}/return", response_model=schemas.RebateReturnOut)
def return_rebate(
    rebate_id: int,
    payload: schemas.RebateReturnIn,
    db: Session = Depends(get_db),
    user: CurrentUser = post_rebate,
) -> schemas.RebateReturnOut:
    """返点退回：在来源订单记一笔真实 OUT 支出，冲减该订单利润。

    发生日取真实退回日（自然归期），累计退回不得超过该笔返点金额；
    返点登记即确认收入、不提供作废/删除，退回是唯一的冲减路径。
    """
    record, flow, already = finance_return_rebate(
        db,
        rebate_id=rebate_id,
        amount=payload.amount,
        returned_on=payload.returned_on,
        note=payload.note,
        actor=_actor(user),
        user=user,
    )
    # remaining 由 RebateOut.remaining 计算字段派生，此处只回传 rebate 与累计已退。
    return schemas.RebateReturnOut(
        rebate=_rebate_out(record, already),
        cashflow=_cashflow_out(db, flow),
        already_returned=already,
    )


# 2026-11-12 裁决：返点登记即确认收入，不提供作废/删除接口。
# 返点不再有 VOID 写入路径；确实要退回该笔钱时，走资金中心「录入流水」登记一笔
# 真实 OUT 支出（有真实发生日、自然归期），不再用 date.today() 的作废冲销撕裂 R2。
# RebateStatus.VOID 枚举与收入侧 `!= VOID` 过滤保留，兼容历史已作废数据。


__all__ = ["router"]
