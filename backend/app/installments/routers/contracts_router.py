"""installments.router：分期合约、收款、交付与逾期标记（HS-01-06）。"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.database import get_db
from app.core.security import (
    PERM_FINANCE_ORDER_EVENT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_UPDATE,
    PERM_ORDER_EVENT_POST,
    CurrentUser,
)
from app.auth.session import (
    require_permissions,
)
from app.domain.enums import AuditAction
from app.installments import schemas
from app.installments import create as inst_create
from app.installments import queries as inst_queries
from app.lists import service as list_columns_service
from app.lists.export import build_list_csv, detail_json
from app.lists.file_response import CSV_MEDIA_TYPE, file_response
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

@router.get("/installments", response_model=list[schemas.InstallmentOut])
def list_installments(
    status: str | None = Query(default=None),
    order_id: int | None = Query(default=None),
    contract_type: str | None = Query(default=None),
    trade_date_from: date | None = Query(default=None),
    trade_date_to: date | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> list[schemas.InstallmentOut]:
    items = inst_queries.list_installments(
        db,
        status=status,
        order_id=order_id,
        contract_type=contract_type,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        user=_user,
    )
    return _installment_outputs(db, items, include_details=True)

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
        inst_create.sale_installment_plan(**payload.model_dump())
    )

@router.get("/installments/export.csv")
def export_installments_csv(
    status: str | None = Query(default=None),
    order_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> Response:
    """分期与回款按可见列导出 CSV：同 /installments 口径，天然全量。"""
    # 直接调路由函数时 Query(default=None) 的默认值不会生效，每个可选筛选都要显式传 None。
    # 此前漏传 contract_type，Query(None) 对象被透传进 SQL 触发 psycopg 参数适配错误。
    outputs = list_installments(
        status=status,
        order_id=order_id,
        contract_type=None,
        trade_date_from=None,
        trade_date_to=None,
        db=db,
        _user=_user,
    )
    rows = [output.model_dump(mode="json") for output in outputs]
    value_labels = list_columns_service.get_value_labels(db, "INSTALLMENT")
    export_details = inst_queries.list_installment_export_details(
        db, [output.id for output in outputs]
    )
    schedules_by_installment, dispositions_by_installment = export_details
    for row, output in zip(rows, outputs, strict=True):
        # 列表列注册表里「剩余」的列 key 是 remaining，而响应字段是 remaining_receivable；
        # 直接读取输出模型的计算字段，保证导出与列表接口使用同一服务端口径。
        row["remaining"] = output.remaining_receivable
        schedules = schedules_by_installment.get(output.id, [])
        dispositions = dispositions_by_installment.get(output.id, [])
        row["installment_note"] = row.get("note")
        row["installment_delivered_on"] = row.get("delivered_on")
        row["installment_first_due_on"] = row.get("first_due_on")
        row["installment_extra_values"] = detail_json(row.get("extra_values") or {}, value_labels)
        row["installment_form_extra"] = detail_json(row.get("form_extra") or {}, value_labels)
        row["installment_schedule"] = detail_json(
            [schemas.ScheduleOut.model_validate(item).model_dump(mode="json") for item in schedules],
            value_labels,
        )
        row["installment_dispositions"] = detail_json(
            [schemas.DispositionOut.model_validate(item).model_dump(mode="json") for item in dispositions],
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
