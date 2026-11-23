"""installments.router：分期合约、收款、交付与逾期标记（HS-01-06）。"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.database import get_db
from app.core.schemas import PageOut
from app.core.errors import PermissionDenied
from app.core.security import (
    PERM_FINANCE_ORDER_EVENT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_UPDATE,
    PERM_ORDER_EVENT_POST,
    CurrentUser,
)
from app.settings.auth.session import (
    require_permissions,
)
from app.domain.enums import AuditAction
from app.business.installments import schemas
from app.business.installments import create as inst_create
from app.business.installments.create_details.plan import sale_installment_plan
from app.business.installments import queries as inst_queries
from app.business.installments.repayments.pay import pay as inst_pay
from app.business.orders.events import post_event as orders_post_event
from app.business.shared.operations.sale import apply_sale_details, sale_form_context
from app.settings.lists import service as list_columns_service
from app.settings.lists.export import build_list_csv, detail_json
from app.settings.lists.file_response import CSV_MEDIA_TYPE, file_response
from app.core.actor import actor_name as _actor


router = APIRouter(tags=["HS-01 分期合约"])

read_access = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
manage = require_permissions(PERM_ORDER_CREATE)
post_payment = require_permissions(
    PERM_ORDER_EVENT_POST, PERM_FINANCE_ORDER_EVENT_POST, require_all=False
)
post_delivery = require_permissions(PERM_ORDER_EVENT_POST)
default_manage = require_permissions(PERM_ORDER_UPDATE)

from ._router_shared import _installment_output, _installment_outputs, INSTALLMENT_DETAIL_EXPORT_COLUMNS

@router.get("/installments", response_model=PageOut[schemas.InstallmentOut])
def list_installments_page(
    status: str | None = Query(default=None),
    order_id: int | None = Query(default=None),
    contract_type: str | None = Query(default=None),
    trade_date_from: date | None = Query(default=None),
    trade_date_to: date | None = Query(default=None),
    limit: int = Query(default=10, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    sort_desc: bool = Query(default=True),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> PageOut[schemas.InstallmentOut]:
    filters = dict(status=status, order_id=order_id, contract_type=contract_type,
                   trade_date_from=trade_date_from, trade_date_to=trade_date_to, user=_user)
    items = inst_queries.list_installments(db, **filters, limit=limit, offset=offset, sort_desc=sort_desc)
    return PageOut(items=_installment_outputs(db, items, include_details=True),
                   total=inst_queries.count_installments(db, **filters), limit=limit, offset=offset)

@router.get("/installments/totals", response_model=schemas.InstallmentTotalsOut)
def installment_totals(
    status: str | None = Query(default=None),
    order_id: int | None = Query(default=None),
    contract_type: str | None = Query(default=None),
    trade_date_from: date | None = Query(default=None),
    trade_date_to: date | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> schemas.InstallmentTotalsOut:
    """分期台合计：与 `/installments` 同一套筛选条件（含 contract_type），Decimal 聚合，前端不再 reduce。"""
    return schemas.InstallmentTotalsOut.model_validate(
        inst_queries.installment_totals(
            db,
            status=status,
            order_id=order_id,
            contract_type=contract_type,
            trade_date_from=trade_date_from,
            trade_date_to=trade_date_to,
            user=_user,
        )
    )

@router.post("/installments/plan", response_model=schemas.SaleInstallmentPlanOut)
def preview_sale_installment_plan(
    payload: schemas.SaleInstallmentPlanIn,
    _user: CurrentUser = manage,
) -> schemas.SaleInstallmentPlanOut:
    """计算库存售出的分期金额；前端只展示该服务端结果。"""
    return schemas.SaleInstallmentPlanOut.model_validate(
        sale_installment_plan(**payload.model_dump())
    )

@router.get("/installments/export.csv")
def export_installments_csv(
    status: str | None = Query(default=None),
    order_id: int | None = Query(default=None),
    contract_type: str | None = Query(default=None),
    trade_date_from: date | None = Query(default=None),
    trade_date_to: date | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> Response:
    """分期与回款按可见列导出 CSV：同 /installments 口径，天然全量。"""
    items = inst_queries.list_installments(
        db,
        status=status,
        order_id=order_id,
        contract_type=contract_type,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        user=_user,
    )
    outputs = _installment_outputs(db, items, include_details=True)
    rows = [output.model_dump(mode="json") for output in outputs]
    value_labels = list_columns_service.get_value_labels(db, "INSTALLMENT")
    for row, output in zip(rows, outputs, strict=True):
        # 列表列注册表里「剩余」的列 key 是 remaining，而响应字段是 remaining_receivable；
        # 直接读取输出模型的计算字段，保证导出与列表接口使用同一服务端口径。
        row["remaining"] = output.remaining_receivable
        row["installment_note"] = row.get("note")
        row["installment_delivered_on"] = row.get("delivered_on")
        row["installment_first_due_on"] = row.get("first_due_on")
        row["installment_extra_values"] = detail_json(row.get("extra_values") or {}, value_labels)
        row["installment_form_extra"] = detail_json(row.get("form_extra") or {}, value_labels)
        row["installment_schedule"] = detail_json(
            [item.model_copy(update={"available_actions": []}).model_dump(mode="json") for item in output.schedules],
            value_labels,
        )
        row["installment_dispositions"] = detail_json(
            [item.model_dump(mode="json") for item in output.dispositions],
            value_labels,
        )
    csv_text, meta = build_list_csv(
        db,
        "INSTALLMENT",
        rows,
        extra_columns=INSTALLMENT_DETAIL_EXPORT_COLUMNS,
    )
    record_audit(
        db,
        action=AuditAction.LIST_EXPORT,
        entity_type="list_export",
        entity_id="INSTALLMENT",
        actor=_user.username,
        after={"rows": len(rows), "column_count": meta["column_count"]},
    )
    return file_response(csv_text, f"分期与回款-{date.today().isoformat()}.csv", CSV_MEDIA_TYPE)

@router.post("/installments/stock-sale", response_model=schemas.InstallmentOut, status_code=201)
def create_stock_sale(
    payload: schemas.StockSaleIn,
    db: Session = Depends(get_db),
    user: CurrentUser = manage,
) -> schemas.InstallmentOut:
    """售出、建立合约与首付款在同一个请求事务中完成。"""
    if not (user.has(PERM_ORDER_EVENT_POST) or user.has(PERM_FINANCE_ORDER_EVENT_POST)):
        raise PermissionDenied("当前角色无权登记售出及分期收款")
    apply_sale_details(db, payload.order_id, customer_input=payload.customer_input,
                       delivery_form_extra=payload.delivery_form_extra, user=user)
    field_context = sale_form_context(payload.customer_input, payload.delivery_form_extra)
    field_context.update({
        "pool_id": payload.pool_id, "down_payment": payload.down_payment, "service_fee": payload.service_fee,
        "periods": payload.periods, "per_period_service_fee": payload.per_period_service_fee,
        "per_period": payload.per_period, "note": payload.note,
    })
    orders_post_event(
        db, payload.order_id, event_type="SELL", sale_mode="INSTALLMENT",
        amount=payload.principal, occurred_on=payload.paid_on, actor=_actor(user),
        portion="PROFIT", operator_user_ids=payload.operator_user_ids, note=payload.note,
        bound_phone=(payload.delivery_form_extra or {}).get("bound_phone"),
        bound_phone_owner=(payload.delivery_form_extra or {}).get("bound_phone_owner"),
        form_extra=payload.form_extra, form_extra_context=field_context, user=user,
    )
    item = inst_create.create_installment(
        db, order_id=payload.order_id, contract_type="STOCK_SALE", principal=payload.principal,
        down_payment=payload.down_payment, service_fee=payload.service_fee, periods=payload.periods,
        per_period_service_fee=payload.per_period_service_fee, per_period=payload.per_period,
        adjust_final_period=payload.adjust_final_period, first_due_on=payload.first_due_on,
        actor=_actor(user), user=user, note=payload.note,
        schedule=[entry.model_dump() for entry in payload.schedule] if payload.schedule else None,
        extra_values=payload.extra_values, operator_user_ids=payload.operator_user_ids,
    )
    if payload.down_payment > 0:
        inst_pay(db, item.id, amount=payload.down_payment, paid_on=payload.paid_on, period_no=0,
                 pool_id=payload.pool_id, actor=_actor(user), operator_user_ids=payload.operator_user_ids,
                 validate_form_fields=False, user=user)
    return _installment_output(db, item)


@router.post("/installments", response_model=schemas.InstallmentOut, status_code=201)
def create_installment(
    payload: schemas.InstallmentCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage,
) -> schemas.InstallmentOut:
    item = inst_create.create_installment(
        db,
        order_id=payload.order_id,
        contract_type=payload.contract_type,
        principal=payload.principal,
        down_payment=payload.down_payment,
        service_fee=payload.service_fee,
        periods=payload.periods,
        per_period_service_fee=payload.per_period_service_fee,
        per_period=payload.per_period,
        adjust_final_period=payload.adjust_final_period,
        first_due_on=payload.first_due_on,
        actor=_actor(user),
        user=user,
        note=payload.note,
        schedule=[item.model_dump() for item in payload.schedule] if payload.schedule else None,
        extra_values=payload.extra_values,
        operator_user_ids=payload.operator_user_ids,
    )
    return _installment_output(db, item)

__all__ = ["router"]
