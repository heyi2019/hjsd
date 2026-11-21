"""资金流水查询、登记和冲销 API。"""
from datetime import date
from decimal import Decimal
from tempfile import SpooledTemporaryFile
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.database import get_db
from app.core.errors import Validation
from app.core.security import (
    PERM_DEPOSIT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_EVENT_POST,
    CurrentUser,
)
from app.settings.auth.session import (
    require_permissions,
)
from app.domain.enums import AuditAction
from app.domain.foundation import Pool
from app.funds import schemas
from app.funds.cashflow_queries import (
    cashflow_totals,
    list_cashflows as finance_list_cashflows,
    studio_summary as finance_studio_summary,
)
from app.funds.cashflows import (
    create_cashflow as finance_create_cashflow,
    delete_cashflow as finance_delete_cashflow,
    reverse_cashflow as finance_reverse_cashflow,
    update_cashflow as finance_update_cashflow,
)
from app.settings.lists.export import build_list_csv
from app.settings.lists.file_response import CSV_MEDIA_TYPE
from ..router_output import _actor, _cashflow_out, _cashflow_outputs

router = APIRouter(tags=["资金流水"])
read_access = require_permissions(PERM_FINANCE_READ, PERM_ORDER_CREATE, require_all=False)
post_deposit = require_permissions(PERM_DEPOSIT_POST)
post_rebate = require_permissions(PERM_ORDER_EVENT_POST)
CASHFLOW_EXPORT_BATCH_SIZE = 2000


def _cashflow_filters(values: dict, *, pool_ids: list[int] | None = None) -> dict:
    """列表、合计和导出使用同一套过滤字段及标准化规则。"""
    keys = ("pool_id", "order_id", "direction", "occurred_from", "occurred_to",
            "ledger_type", "accounting_attribute", "category", "created_by", "keyword", "user")
    filters = {key: values[key] for key in keys}
    for key in ("ledger_type", "accounting_attribute", "category"):
        value = filters[key]
        filters[key] = value.strip().upper() if value else None
    filters["pool_ids"] = pool_ids
    return filters


@router.get("/cashflows/studio-summary", response_model=schemas.StudioSummaryOut)
def studio_summary(
    pool_ids: str | None = Query(
        default=None,
        description="逗号分隔的资金账户 ID；不传则按当前用户可见池",
    ),
    occurred_from: date | None = Query(default=None),
    occurred_to: date | None = Query(default=None),
    category: str | None = Query(default=None),
    sort_desc: bool = Query(default=True),
    limit: int = Query(default=200, ge=1, le=2000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> schemas.StudioSummaryOut:
    """工作室收支面板：一次返回明细与已入账汇总。

    「哪些流水算工作室收支」的口径在 `finance_studio_summary` 里，前端不再自己过滤、
    也不再对当页求和（原先收入/支出各拉一次，再 reduce 出两个合计和一个净额）。
    """
    parsed: list[int] | None = None
    if pool_ids:
        try:
            parsed = [int(item) for item in pool_ids.split(",") if item.strip()]
        except ValueError as exc:
            raise Validation(
                "pool_ids 必须是逗号分隔的整数",
                details={"field": "pool_ids", "value": pool_ids},
            ) from exc
    result = finance_studio_summary(
        db,
        pool_ids=parsed,
        occurred_from=occurred_from,
        occurred_to=occurred_to,
        category=category.strip().upper() if category else None,
        sort_desc=sort_desc,
        limit=limit,
        offset=offset,
        user=user,
    )
    return schemas.StudioSummaryOut(
        items=_cashflow_outputs(db, result["items"]),
        income=result["income"],
        expense=result["expense"],
        net=result["net"],
        count=result["count"],
    )


@router.get("/cashflows", response_model=schemas.CashflowListOut)
def list_cashflows(
    pool_id: int | None = Query(default=None),
    order_id: int | None = Query(default=None),
    direction: str | None = Query(default=None),
    occurred_from: date | None = Query(default=None),
    occurred_to: date | None = Query(default=None),
    ledger_type: str | None = Query(default=None),
    accounting_attribute: str | None = Query(default=None),
    category: str | None = Query(default=None),
    created_by: str | None = Query(default=None),
    keyword: str | None = Query(default=None),
    sort_desc: bool = Query(default=True),
    limit: int = Query(default=100, ge=1, le=2000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> schemas.CashflowListOut:
    empty = schemas.CashflowListOut(
        items=[], total=0, total_in=Decimal("0"), total_out=Decimal("0")
    )
    if pool_id is not None and not user.can_see_pool(pool_id):
        return empty
    pool_ids: list[int] | None = None
    if pool_id is None and not (user.is_admin or user.owner_scope == "ALL"):
        if not user.pool_ids:
            return empty
        pool_ids = sorted(user.pool_ids)

    filters = _cashflow_filters(locals(), pool_ids=pool_ids)
    items, total = finance_list_cashflows(db, limit=limit, offset=offset, sort_desc=sort_desc, **filters)
    # 合计与明细同条件、同源：前端不再对当页求和，超 limit 也不会少算。
    total_in, total_out = cashflow_totals(db, **filters)
    return schemas.CashflowListOut(
        items=_cashflow_outputs(db, items),
        total=total,
        total_in=total_in,
        total_out=total_out,
    )


@router.get("/cashflows/totals", response_model=schemas.CashflowTotalsOut)
def list_cashflow_totals(
    pool_id: int | None = Query(default=None),
    order_id: int | None = Query(default=None),
    direction: str | None = Query(default=None),
    occurred_from: date | None = Query(default=None),
    occurred_to: date | None = Query(default=None),
    ledger_type: str | None = Query(default=None),
    accounting_attribute: str | None = Query(default=None),
    category: str | None = Query(default=None),
    created_by: str | None = Query(default=None),
    keyword: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> schemas.CashflowTotalsOut:
    """只返回流水合计，供筛选变更时刷新统计卡，不下载分页明细。"""
    if pool_id is not None and not user.can_see_pool(pool_id):
        return schemas.CashflowTotalsOut()
    pool_ids: list[int] | None = None
    if pool_id is None and not (user.is_admin or user.owner_scope == "ALL"):
        if not user.pool_ids:
            return schemas.CashflowTotalsOut()
        pool_ids = sorted(user.pool_ids)
    total_in, total_out = cashflow_totals(db, **_cashflow_filters(locals(), pool_ids=pool_ids))
    return schemas.CashflowTotalsOut(total_in=total_in, total_out=total_out)


@router.get("/cashflows/export.csv")
def export_cashflows_csv(
    pool_id: int | None = Query(default=None),
    order_id: int | None = Query(default=None),
    direction: str | None = Query(default=None),
    occurred_from: date | None = Query(default=None),
    occurred_to: date | None = Query(default=None),
    ledger_type: str | None = Query(default=None),
    accounting_attribute: str | None = Query(default=None),
    category: str | None = Query(default=None),
    created_by: str | None = Query(default=None),
    keyword: str | None = Query(default=None),
    sort_desc: bool = Query(default=True),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> Response:
    can_read = (
        user.can_see_pool(pool_id) if pool_id is not None
        else user.is_admin or user.owner_scope == "ALL" or bool(user.pool_ids)
    )
    filters = _cashflow_filters(locals())
    output = SpooledTemporaryFile(max_size=1024 * 1024, mode="w+b")
    offset = 0
    try:
        while True:
            items, total = finance_list_cashflows(
                db, limit=CASHFLOW_EXPORT_BATCH_SIZE, offset=offset, sort_desc=sort_desc, **filters,
            ) if can_read else ([], 0)
            rows = [item.model_dump() for item in _cashflow_outputs(db, items)]
            pool_ids = {row["pool_id"] for row in rows}
            pool_names = (
                dict(db.execute(select(Pool.id, Pool.name).where(Pool.id.in_(pool_ids))).all())
                if pool_ids else {}
            )
            for row in rows:
                row["pool_name"] = pool_names.get(row["pool_id"], f"账户 {row['pool_id']}")
            csv_text, meta = build_list_csv(
                db, "CASHFLOW", rows, include_header=offset == 0,
            )
            output.write(csv_text.encode("utf-8"))
            offset += len(rows)
            if not rows or offset >= total:
                break
        record_audit(
            db, action=AuditAction.LIST_EXPORT, entity_type="list_export", entity_id="CASHFLOW",
            actor=user.username, after={"rows": offset, "column_count": meta["column_count"]},
        )
        output.seek(0)
    except Exception:
        output.close()
        raise

    def stream():
        try:
            yield from output
        finally:
            output.close()

    filename = f"资金流水-{date.today().isoformat()}.csv"
    return StreamingResponse(stream(), media_type=CSV_MEDIA_TYPE,
                             headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"})


@router.post("/cashflows", response_model=schemas.CashflowOut, status_code=201)
def create_cashflow(
    payload: schemas.CashflowCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.CashflowOut:
    flow = finance_create_cashflow(
        db,
        pool_id=payload.pool_id,
        occurred_on=payload.occurred_on,
        direction=payload.direction.strip().upper(),
        ledger_type=payload.ledger_type.strip().upper(),
        accounting_attribute=(
            payload.accounting_attribute.strip().upper()
            if payload.accounting_attribute
            else None
        ),
        category=payload.category,
        amount=payload.amount,
        operator_user_ids=payload.operator_user_ids,
        order_id=payload.order_id,
        note=payload.note,
        extra_values=payload.extra_values,
        form_extra=payload.form_extra,
        form_extra_scope="REFUND" if payload.order_id is not None else payload.form_extra_scope,
        actor=_actor(user),
        user=user,
    )
    return _cashflow_out(db, flow)


@router.post("/orders/{order_id}/cashflows", response_model=schemas.CashflowOut, status_code=201)
def create_order_cashflow(
    order_id: int,
    payload: schemas.CashflowCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_rebate,
) -> schemas.CashflowOut:
    """登记订单关联的收入/支出资金明细，不新增业务事件。"""
    if payload.order_id is not None and payload.order_id != order_id:
        raise Validation(
            "资金明细关联订单与路径订单不一致",
            details={"field": "order_id", "order_id": order_id},
        )
    flow = finance_create_cashflow(
        db,
        pool_id=payload.pool_id,
        occurred_on=payload.occurred_on,
        direction=payload.direction.strip().upper(),
        ledger_type=payload.ledger_type.strip().upper(),
        accounting_attribute=(
            payload.accounting_attribute.strip().upper()
            if payload.accounting_attribute
            else None
        ),
        category=payload.category,
        amount=payload.amount,
        operator_user_ids=payload.operator_user_ids,
        order_id=order_id,
        note=payload.note,
        extra_values=payload.extra_values,
        form_extra=payload.form_extra,
        form_extra_scope="REFUND",
        actor=_actor(user),
        user=user,
    )
    return _cashflow_out(db, flow)


@router.put("/cashflows/{cashflow_id}", response_model=schemas.CashflowOut)
def update_cashflow(
    cashflow_id: int,
    payload: schemas.CashflowUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.CashflowOut:
    flow = finance_update_cashflow(
        db,
        cashflow_id,
        pool_id=payload.pool_id,
        occurred_on=payload.occurred_on,
        direction=payload.direction.strip().upper(),
        accounting_attribute=payload.accounting_attribute.strip().upper() if payload.accounting_attribute else None,
        category=payload.category,
        amount=payload.amount,
        note=payload.note,
        operator_user_ids=payload.operator_user_ids,
        form_extra=payload.form_extra,
        actor=_actor(user),
        user=user,
    )
    return _cashflow_out(db, flow)


@router.delete("/cashflows/{cashflow_id}", status_code=204, response_model=None)
def delete_cashflow(
    cashflow_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> None:
    finance_delete_cashflow(db, cashflow_id, actor=_actor(user), user=user)


@router.post("/cashflows/{cashflow_id}/reverse", response_model=schemas.CashflowOut)
def reverse_cashflow(
    cashflow_id: int,
    payload: schemas.CashflowReverse,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.CashflowOut:
    flow = finance_reverse_cashflow(
        db,
        cashflow_id,
        reversed_on=payload.reversed_on,
        actor=_actor(user),
        reason=payload.reason,
        form_extra=payload.form_extra,
        form_extra_scope=payload.form_extra_scope,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return _cashflow_out(db, flow)


