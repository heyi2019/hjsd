"""finance.router：押金与返点 API（FIN-04 / REB-01）。

押金不在列表内直接登记，缴纳/释放走独立写接口并产生现金流；
返点登记即完成收入确认，金额唯一取 `rebate_records.base_amount`，
不再有分次结算 / 冲销写接口。
"""

from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import NotFound, Validation
from app.core.audit import record_audit
from app.core.security import (
    PERM_DEPOSIT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_EVENT_POST,
    PERM_TRANSFER_POST,
    CurrentUser,
    require_permissions,
)
from app.finance import schemas
from app.finance.cashflows import (
    cashflow_totals,
    create_cashflow as finance_create_cashflow,
    list_cashflows as finance_list_cashflows,
    reverse_cashflow as finance_reverse_cashflow,
    studio_summary as finance_studio_summary,
)
from app.finance.deposits import (
    cancel_deposit as finance_cancel_deposit,
    create_deposit as finance_create_deposit,
    list_deposits as finance_list_deposits,
    lose_deposit as finance_lose_deposit,
    return_deposit as finance_return_deposit,
)
from app.finance.rebates import (
    create_rebate as finance_create_rebate,
    get_rebate as finance_get_rebate,
    list_rebates as finance_list_rebates,
    rebate_returned_totals,
    return_rebate as finance_return_rebate,
    update_rebate as finance_update_rebate,
)
from app.finance.reconciliation import (
    create_reconciliation as finance_create_reconciliation,
    list_reconciliations as finance_list_reconciliations,
    resolve_reconciliation as finance_resolve_reconciliation,
)
from app.finance.transfers import (
    create_transfer as finance_create_transfer,
    repair_transfer as finance_repair_transfer,
)
from app.domain.enums import AuditAction
from app.domain.trade import Deposit
from app.lists.export import EXPORT_ROW_LIMIT, build_list_csv
from app.lists.file_response import CSV_MEDIA_TYPE, file_response
from app.orders._shared import get_order

from .router_output import (
    _actor,
    _cashflow_out,
    _deposit_out,
    _rebate_out,
    _reconciliation_out,
    _transfer_out,
)

router = APIRouter(tags=["FIN-04/REB-01 押金与返点"])

read_access = require_permissions(PERM_FINANCE_READ, PERM_ORDER_CREATE, require_all=False)
post_deposit = require_permissions(PERM_DEPOSIT_POST)
post_rebate = require_permissions(PERM_ORDER_EVENT_POST)
post_transfer = require_permissions(PERM_TRANSFER_POST)


@router.get("/cashflows/studio-summary", response_model=schemas.StudioSummaryOut)
def studio_summary(
    pool_ids: str | None = Query(
        default=None,
        description="逗号分隔的资金池 ID；不传则按当前用户可见池",
    ),
    occurred_from: date | None = Query(default=None),
    occurred_to: date | None = Query(default=None),
    category: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=2000),
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
        limit=limit,
        user=user,
    )
    return schemas.StudioSummaryOut(
        items=[_cashflow_out(db, item) for item in result["items"]],
        approved_income=result["approved_income"],
        approved_expense=result["approved_expense"],
        approved_net=result["approved_net"],
        count=result["count"],
    )


@router.get("/cashflows", response_model=schemas.CashflowListOut)
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
    keyword: str | None = Query(default=None),
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

    filters = {
        "pool_id": pool_id,
        "pool_ids": pool_ids,
        "order_id": order_id,
        "direction": direction,
        "occurred_from": occurred_from,
        "occurred_to": occurred_to,
        "status": status,
        "nature": nature.strip().upper() if nature else None,
        "fund_nature": fund_nature.strip().upper() if fund_nature else None,
        "accounting_attribute": (
            accounting_attribute.strip().upper() if accounting_attribute else None
        ),
        "category": category.strip().upper() if category else None,
        "created_by": created_by,
        "keyword": keyword,
        "user": user,
    }
    items, total = finance_list_cashflows(db, limit=limit, offset=offset, **filters)
    # 合计与明细同条件、同源：前端不再对当页求和，超 limit 也不会少算。
    total_in, total_out = cashflow_totals(db, **filters)
    return schemas.CashflowListOut(
        items=[_cashflow_out(db, item) for item in items],
        total=total,
        total_in=total_in,
        total_out=total_out,
    )


@router.get("/cashflows/export.csv")
def export_cashflows_csv(
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
    keyword: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> Response:
    # 直接调用路由函数时 `Query(default=None)` 不会被解析成 None，
    # 漏传 keyword 会把 Query 对象一路带进 SQL 条件（曾让导出直接 500）。
    result = list_cashflows(
        pool_id=pool_id,
        order_id=order_id,
        direction=direction,
        occurred_from=occurred_from,
        occurred_to=occurred_to,
        status=status,
        nature=nature,
        fund_nature=fund_nature,
        accounting_attribute=accounting_attribute,
        category=category,
        created_by=created_by,
        keyword=keyword,
        limit=EXPORT_ROW_LIMIT,
        offset=0,
        db=db,
        user=user,
    )
    rows = [item.model_dump() for item in result.items]
    csv_text, meta = build_list_csv(db, "CASHFLOW", rows)
    record_audit(
        db,
        action=AuditAction.LIST_EXPORT,
        entity_type="list_export",
        entity_id="CASHFLOW",
        actor=user.username,
        after={"rows": len(rows), "column_count": meta["column_count"]},
    )
    return file_response(csv_text, f"资金流水-{date.today().isoformat()}.csv", CSV_MEDIA_TYPE)


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
        form_extra=payload.form_extra,
        form_extra_scope=payload.form_extra_scope,
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
        nature=payload.nature.strip().upper(),
        fund_nature=payload.fund_nature.strip().upper() if payload.fund_nature else None,
        accounting_attribute=(
            payload.accounting_attribute.strip().upper()
            if payload.accounting_attribute
            else None
        ),
        category=payload.category,
        amount=payload.amount,
        order_id=order_id,
        note=payload.note,
        extra_values=payload.extra_values,
        form_extra=payload.form_extra,
        form_extra_scope=payload.form_extra_scope,
        actor=_actor(user),
        user=user,
    )
    return _cashflow_out(db, flow)


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
        user=user,
    )
    return _cashflow_out(db, flow)


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
    return [_reconciliation_out(item) for item in items]


@router.post("/reconciliations", response_model=schemas.ReconciliationOut, status_code=201)
def create_reconciliation(
    payload: schemas.ReconciliationCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_deposit,
) -> schemas.ReconciliationOut:
    if not user.can_see_pool(payload.pool_id):
        raise NotFound("资金池不存在", details={"pool_id": payload.pool_id})
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
    item = finance_resolve_reconciliation(
        db,
        reconciliation_id,
        actor=_actor(user),
        reason=payload.reason,
        form_extra=payload.form_extra,
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
    result = finance_create_transfer(
        db,
        source_pool_id=payload.source_pool_id,
        target_pool_id=payload.target_pool_id,
        amount=payload.amount,
        occurred_on=payload.occurred_on,
        actor=_actor(user),
        note=payload.note,
        form_extra=payload.form_extra,
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
    result = finance_repair_transfer(
        db,
        transfer_id,
        counterpart_pool_id=payload.counterpart_pool_id,
        actor=_actor(user),
        reason=payload.reason,
        form_extra=payload.form_extra,
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
        base_amount=payload.base_amount,
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
