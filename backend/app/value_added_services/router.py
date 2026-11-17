"""value_added_services.router：分期合约、收款、交付与逾期标记（HS-01-06）。"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.database import get_db
from app.core.errors import NotFound
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
from app.domain.trade import InstallmentSchedule, Order
from app.value_added_services import schemas
from app.value_added_services import _shared as inst__shared
from app.value_added_services import create as inst_create
from app.value_added_services import queries as inst_queries
from app.value_added_services import recovery as inst_recovery
from app.value_added_services import repayment as inst_repayment
from app.value_added_services import settlement as inst_settlement
from app.lists import service as list_columns_service
from app.lists.export import build_list_csv, detail_json
from app.lists.file_response import CSV_MEDIA_TYPE, file_response
from app.shared.form_values import get_extra_values_bulk
from app.core.actor import actor_name as _actor
from app.shared.operation_operators import (
    get_operation_operators,
    list_operation_operators_bulk,
    upsert_operation_operators,
)

router = APIRouter(tags=["HS-01 分期合约"])

read_access = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
manage = require_permissions(PERM_ORDER_CREATE)
post_payment = require_permissions(
    PERM_ORDER_EVENT_POST, PERM_FINANCE_ORDER_EVENT_POST, require_all=False
)
post_delivery = require_permissions(PERM_ORDER_EVENT_POST)
default_manage = require_permissions(PERM_ORDER_UPDATE)

INSTALLMENT_DETAIL_EXPORT_COLUMNS = [
    ("installment_note", "备注", True),
    ("installment_delivery_mode", "交付方式", True),
    ("installment_delivered_on", "交付时间", True),
    ("installment_first_due_on", "首期到期日", True),
    ("installment_extra_values", "合约扩展字段", True),
    ("installment_form_extra", "操作扩展字段", True),
    ("installment_schedule", "期次明细", True),
    ("installment_dispositions", "处置记录", True),
]


def _installment_outputs(
    db: Session,
    items,
    *,
    include_details: bool = False,
) -> list[schemas.InstallmentOut]:
    if not items:
        return []
    extras = get_extra_values_bulk(
        db, entity_type="installment", entity_ids=[item.id for item in items]
    )
    order_ids = {item.order_id for item in items}
    orders = {
        order.id: order
        for order in db.scalars(select(Order).where(Order.id.in_(order_ids))).all()
    }
    order_context = inst_queries.installment_order_context(db, list(orders.values()))
    schedules_by_installment: dict[int, list] = {}
    dispositions_by_installment: dict[int, list] = {}
    if include_details:
        schedules_by_installment, dispositions_by_installment = (
            inst_queries.list_installment_export_details(db, [item.id for item in items])
        )
    operator_rows_by_installment = list_operation_operators_bulk(
        db,
        entity_type="installment",
        entity_ids=[item.inst_no for item in items],
    )
    return [
        schemas.InstallmentOut.model_validate({
            **item.__dict__,
            "operator": item.created_by,
            "extra_values": extras.get(item.id, {}),
            "order": order_context[item.order_id],
            "schedules": [schemas.ScheduleOut.model_validate(row) for row in schedules_by_installment.get(item.id, [])],
            "dispositions": [schemas.DispositionOut.model_validate(row) for row in dispositions_by_installment.get(item.id, [])],
            "operation_operators": [
                schemas.OperationOperatorOut.model_validate(row)
                for row in operator_rows_by_installment.get(item.inst_no, [])
            ],
        })
        for item in items
    ]


def _installment_output(db: Session, item) -> schemas.InstallmentOut:
    return _installment_outputs(db, [item])[0]


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
        row["installment_delivery_mode"] = row.get("delivery_mode")
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
        delivery_mode=payload.delivery_mode,
        note=payload.note,
        schedule=[item.model_dump() for item in payload.schedule] if payload.schedule else None,
        extra_values=payload.extra_values,
        operator_user_ids=payload.operator_user_ids,
    )
    return _installment_output(db, item)


@router.put(
    "/installments/{installment_id}/operation-operators/{operation_key}",
    response_model=schemas.InstallmentOut,
)
def update_installment_operation_operators(
    installment_id: int,
    operation_key: str,
    payload: schemas.OperationOperatorsUpdateIn,
    db: Session = Depends(get_db),
    user: CurrentUser = default_manage,
) -> schemas.InstallmentOut:
    """详情页只更新动作操作人，不改建单人和动作发生时间。"""
    item = inst__shared.get_installment(db, installment_id, user)
    existing = get_operation_operators(
        db,
        entity_type="installment",
        entity_id=item.inst_no,
        operation_key=operation_key,
    )
    if existing is None:
        raise NotFound("业务动作操作人记录不存在")
    before = list(existing.operator_user_ids)
    upsert_operation_operators(
        db,
        entity_type="installment",
        entity_id=item.inst_no,
        operation_key=operation_key,
        actor=_actor(user),
        operator_user_ids=payload.operator_user_ids,
        occurred_at=existing.occurred_at,
    )
    record_audit(
        db,
        action=AuditAction.ORDER_UPDATE,
        entity_type="installment_operation_operators",
        entity_id=f"{item.inst_no}:{operation_key}",
        actor=_actor(user),
        before={"operator_user_ids": before},
        after={"operator_user_ids": payload.operator_user_ids},
    )
    return _installment_output(db, item)


@router.get("/installments/{installment_id}/schedules", response_model=list[schemas.ScheduleOut])
def list_schedules(
    installment_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> list[schemas.ScheduleOut]:
    inst__shared.get_installment(db, installment_id, _user)
    rows = db.scalars(
        select(InstallmentSchedule)
        .where(InstallmentSchedule.installment_id == installment_id)
        .order_by(InstallmentSchedule.period_no)
    ).all()
    return [schemas.ScheduleOut.model_validate(row) for row in rows]


@router.post(
    "/installments/{installment_id}/schedules/{period_no}/waive",
    response_model=schemas.ScheduleOut,
)
def waive_schedule(
    installment_id: int,
    period_no: int,
    payload: schemas.ScheduleWaiveIn,
    db: Session = Depends(get_db),
    user: CurrentUser = default_manage,
) -> schemas.ScheduleOut:
    item = inst_repayment.waive_schedule(
        db,
        installment_id,
        period_no=period_no,
        amount=payload.amount,
        waived_on=payload.waived_on,
        actor=_actor(user),
        reason=payload.reason,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return schemas.ScheduleOut.model_validate(item)


@router.post(
    "/installments/{installment_id}/schedules/{period_no}/extend",
    response_model=schemas.ScheduleOut,
)
def extend_schedule(
    installment_id: int,
    period_no: int,
    payload: schemas.ScheduleExtendIn,
    db: Session = Depends(get_db),
    user: CurrentUser = default_manage,
) -> schemas.ScheduleOut:
    item = inst_repayment.extend_schedule(
        db,
        installment_id,
        period_no=period_no,
        new_due_on=payload.new_due_on,
        actor=_actor(user),
        reason=payload.reason,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return schemas.ScheduleOut.model_validate(item)


@router.post(
    "/installments/{installment_id}/payments", response_model=schemas.PaymentResult
)
def pay_installment(
    installment_id: int,
    payload: schemas.PaymentIn,
    db: Session = Depends(get_db),
    user: CurrentUser = post_payment,
) -> schemas.PaymentResult:
    installment, schedule = inst_repayment.pay(
        db,
        installment_id,
        amount=payload.amount,
        paid_on=payload.paid_on,
        period_no=payload.period_no,
        actor=_actor(user),
        pool_id=payload.pool_id,
        note=payload.note,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return schemas.PaymentResult(
        installment=_installment_output(db, installment),
        schedule=schemas.ScheduleOut.model_validate(schedule),
    )


@router.post(
    "/installments/{installment_id}/cancel",
    response_model=schemas.InstallmentCancelResult,
)
def cancel_installment(
    installment_id: int,
    payload: schemas.CancelIn,
    db: Session = Depends(get_db),
    user: CurrentUser = post_payment,
) -> schemas.InstallmentCancelResult:
    result = inst_repayment.cancel_installment(
        db,
        installment_id,
        cancelled_on=payload.cancelled_on,
        actor=_actor(user),
        reason=payload.reason,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return schemas.InstallmentCancelResult(
        installment=_installment_output(db, result["installment"]),
        order_status=result["order_status"],
        account_status=result["account_status"],
        refund_amount=result["refund_amount"],
        reversed_amount=result["reversed_amount"],
        cancel_event_ids=result["cancel_event_ids"],
    )


@router.post(
    "/installments/{installment_id}/settle-early", response_model=schemas.InstallmentOut
)
def settle_early_installment(
    installment_id: int,
    payload: schemas.EarlySettlementIn,
    db: Session = Depends(get_db),
    user: CurrentUser = post_payment,
) -> schemas.InstallmentOut:
    item = inst_settlement.settle_early(
        db,
        installment_id,
        paid_on=payload.paid_on,
        pool_id=payload.pool_id,
        note=payload.note,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        actor=_actor(user),
        user=user,
    )
    return _installment_output(db, item)


@router.post(
    "/installments/{installment_id}/default", response_model=schemas.InstallmentOut
)
def default_installment(
    installment_id: int,
    payload: schemas.DefaultIn,
    db: Session = Depends(get_db),
    user: CurrentUser = default_manage,
) -> schemas.InstallmentOut:
    item = inst_settlement.mark_default(
        db,
        installment_id,
        actor=_actor(user),
        reason=payload.reason,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return _installment_output(db, item)


@router.post(
    "/installments/{installment_id}/recover",
    response_model=schemas.DispositionOut,
)
def recover_installment_account(
    installment_id: int,
    payload: schemas.DispositionIn,
    db: Session = Depends(get_db),
    user: CurrentUser = default_manage,
) -> schemas.DispositionOut:
    item = inst_recovery.recover_account(
        db,
        installment_id,
        occurred_on=payload.occurred_on,
        actor=_actor(user),
        note=payload.note,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return schemas.DispositionOut.model_validate(item)


@router.get(
    "/installments/{installment_id}/dispositions",
    response_model=list[schemas.DispositionOut],
)
def list_installment_dispositions(
    installment_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> list[schemas.DispositionOut]:
    return [
        schemas.DispositionOut.model_validate(item)
        for item in inst_recovery.list_dispositions(db, installment_id, user)
    ]


@router.post(
    "/installments/{installment_id}/resale",
    response_model=schemas.DispositionOut,
)
def resale_installment_account(
    installment_id: int,
    payload: schemas.ResaleIn,
    db: Session = Depends(get_db),
    user: CurrentUser = default_manage,
) -> schemas.DispositionOut:
    item = inst_recovery.record_sale(
        db,
        installment_id,
        sale_order_id=payload.resale_order_id,
        occurred_on=payload.occurred_on,
        actor=_actor(user),
        note=payload.note,
        form_extra=payload.form_extra,
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return schemas.DispositionOut.model_validate(item)


@router.post(
    "/installments/{installment_id}/deliver", response_model=schemas.InstallmentOut
)
def deliver_installment(
    installment_id: int,
    payload: schemas.DeliverIn,
    db: Session = Depends(get_db),
    user: CurrentUser = post_delivery,
) -> schemas.InstallmentOut:
    item = inst_recovery.deliver(
        db,
        installment_id,
        delivery_mode=payload.delivery_mode,
        delivered_on=payload.delivered_on,
        note=payload.note,
        bound_phone=payload.bound_phone,
        bound_phone_owner=payload.bound_phone_owner,
        form_extra=payload.form_extra,
        actor=_actor(user),
        operator_user_ids=payload.operator_user_ids,
        user=user,
    )
    return _installment_output(db, item)


@router.post(
    "/installments/mark-overdue",
    response_model=schemas.MarkOverdueOut,
    status_code=200,
)
def mark_overdue(
    as_of: date = Query(default_factory=date.today),
    db: Session = Depends(get_db),
    user: CurrentUser = post_delivery,
) -> schemas.MarkOverdueOut:
    return schemas.MarkOverdueOut(
        marked=inst_recovery.mark_overdue(db, as_of=as_of, actor=_actor(user), user=user)
    )


__all__ = ["router"]
