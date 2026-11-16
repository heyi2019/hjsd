"""parties.router：客户、合作方与表单扩展字段 API（CUS-01 / BAS-02-05 / BAS-04）。

联系方式直接返回档案原值；修改联系方式/备注须 `customer.contact.write`；合并须 `customer.merge`。
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.core.actor import actor_name as _actor
from app.core.audit import record_audit
from app.core.database import get_db
from app.core.errors import PermissionDenied
from app.core.schemas import PageOut
from app.core.security import (
    PERM_COUNTERPARTY_MANAGE,
    PERM_COUNTERPARTY_READ,
    PERM_CUSTOMER_CREATE,
    PERM_CUSTOMER_MERGE,
    PERM_CUSTOMER_READ,
    PERM_CUSTOMER_UPDATE,
    CurrentUser,
    require_permissions,
)
from app.domain.enums import AuditAction
from app.lists.export import EXPORT_ROW_LIMIT, build_list_csv
from app.lists.file_response import CSV_MEDIA_TYPE, file_response
from app.parties import schemas
from app.parties._common import to_counterparty_out, to_customer_out
from app.parties.counterparties import (
    create_counterparty as parties_create_counterparty,
    count_counterparties as parties_count_counterparties,
    get_counterparty as parties_get_counterparty,
    list_counterparties as parties_list_counterparties,
    set_counterparty_status,
    update_counterparty as parties_update_counterparty,
)
from app.parties.customer_detail import (
    get_customer_activity_summary,
    get_customer_detail as parties_get_customer_detail,
)
from app.parties.customer_merge import (
    duplicate_candidates,
    merge_customers as parties_merge_customers,
)
from app.parties.customers import (
    count_customers,
    create_customer as parties_create_customer,
    get_customer as parties_get_customer,
    list_customers as parties_list_customers,
    summarize_customers as parties_summarize_customers,
    set_customer_status,
    update_customer as parties_update_customer,
)
from app.parties.fields import get_extra_values, get_extra_values_bulk
from app.parties.leads import (
    close_lead as parties_close_lead,
    convert_lead as parties_convert_lead,
    create_lead as parties_create_lead,
    get_lead as parties_get_lead,
    list_leads as parties_list_leads,
    summarize_leads as parties_summarize_leads,
    update_lead as parties_update_lead,
)

from .router_output import _counterparty_output, _lead_output, _lead_outputs

router = APIRouter(tags=["CUS-01 客户与合作方"])

read_customers = require_permissions(PERM_CUSTOMER_READ)
create_customers = require_permissions(PERM_CUSTOMER_CREATE)
update_customers = require_permissions(PERM_CUSTOMER_UPDATE)
merge_customers = require_permissions(PERM_CUSTOMER_MERGE)
read_counterparties = require_permissions(PERM_COUNTERPARTY_READ)
manage_counterparties = require_permissions(PERM_COUNTERPARTY_MANAGE)


# --------------------------------------------------------------------- 客户
@router.get("/customers", response_model=PageOut[schemas.CustomerOut])
def list_customers(
    keyword: str | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> PageOut[schemas.CustomerOut]:
    customers = parties_list_customers(
        db, keyword=keyword, status=status, user=user, limit=limit, offset=offset
    )
    extras = get_extra_values_bulk(
        db, entity_type="customer", entity_ids=[item.id for item in customers]
    )
    activity = get_customer_activity_summary(
        db, [item.id for item in customers]
    )
    return PageOut(
        items=[
            to_customer_out(
                item,
                extra_values=extras.get(item.id),
                activity_summary=activity.get(item.id),
            )
            for item in customers
        ],
        total=count_customers(db, keyword=keyword, status=status, user=user),
        limit=limit,
        offset=offset,
    )


@router.get("/customers/summary", response_model=schemas.CustomerSummaryOut)
def customer_summary(
    today_date: date = Query(...),
    keyword: str | None = Query(default=None),
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> schemas.CustomerSummaryOut:
    return schemas.CustomerSummaryOut(**parties_summarize_customers(
        db, today_date=today_date, keyword=keyword, status=status, user=user
    ))


@router.get("/customers/export.csv")
def export_customers_csv(
    keyword: str | None = Query(default=None),
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> Response:
    """客户按可见列导出 CSV：同 /customers 筛选口径，上限 EXPORT_ROW_LIMIT。"""
    customers = parties_list_customers(
        db, keyword=keyword, status=status, user=user, limit=EXPORT_ROW_LIMIT, offset=0
    )
    extras = get_extra_values_bulk(
        db, entity_type="customer", entity_ids=[item.id for item in customers]
    )
    activity = get_customer_activity_summary(db, [item.id for item in customers])
    rows = [
        to_customer_out(
            item,
            extra_values=extras.get(item.id),
            activity_summary=activity.get(item.id),
        )
        for item in customers
    ]
    csv_text, meta = build_list_csv(db, "CUSTOMER", rows)
    record_audit(
        db,
        action=AuditAction.LIST_EXPORT,
        entity_type="list_export",
        entity_id="CUSTOMER",
        actor=user.username,
        after={
            "rows": meta["row_count"],
            "column_count": meta["column_count"],
            "truncated": meta["truncated"],
        },
    )
    return file_response(csv_text, f"客户-{date.today().isoformat()}.csv", CSV_MEDIA_TYPE)


@router.post(
    "/customers", response_model=schemas.CustomerWithCandidates, status_code=201
)
def create_customer(
    payload: schemas.CustomerCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = create_customers,
) -> schemas.CustomerWithCandidates:
    customer = parties_create_customer(
        db,
        display_name=payload.display_name,
        actor=_actor(user),
        contact_name=payload.contact_name,
        phone=payload.phone,
        wechat=payload.wechat,
        qq=payload.qq,
        source=payload.source,
        owner_id=(
            user.id
            if not user.is_admin and user.owner_scope != "ALL"
            else payload.owner_id
        ),
        tags=payload.tags,
        note=payload.note,
        extra_values=payload.extra_values,
    )
    candidates = duplicate_candidates(
        db,
        phone=payload.phone,
        wechat=payload.wechat,
        qq=payload.qq,
        exclude_customer_id=customer.id,
        user=user,
    )
    extras = get_extra_values(db, entity_type="customer", entity_id=customer.id)
    return schemas.CustomerWithCandidates(
        customer=to_customer_out(
            customer, extra_values=extras
        ),
        duplicate_candidates=candidates,
    )


@router.get("/customers/{customer_id}", response_model=schemas.CustomerOut)
def get_customer(
    customer_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> schemas.CustomerOut:
    customer = parties_get_customer(db, customer_id, user)
    extras = get_extra_values(db, entity_type="customer", entity_id=customer.id)
    return to_customer_out(customer, extra_values=extras)


@router.get("/customers/{customer_id}/detail", response_model=schemas.CustomerDetailOut)
def get_customer_detail(
    customer_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> schemas.CustomerDetailOut:
    customer = parties_get_customer(db, customer_id, user)
    extras = get_extra_values(db, entity_type="customer", entity_id=customer.id)
    return schemas.CustomerDetailOut(
        customer=to_customer_out(
            customer, extra_values=extras
        ),
        **parties_get_customer_detail(db, customer_id, user),
    )


@router.patch("/customers/{customer_id}", response_model=schemas.CustomerOut)
def update_customer(
    customer_id: int,
    payload: schemas.CustomerUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = update_customers,
) -> schemas.CustomerOut:
    customer = parties_update_customer(
        db,
        customer_id,
        actor=_actor(user),
        user=user,
        extra_values=payload.extra_values,
        **payload.model_dump(exclude_unset=True),
    )
    extras = get_extra_values(db, entity_type="customer", entity_id=customer.id)
    return to_customer_out(
        customer,
        extra_values=extras,
    )


@router.patch("/customers/{customer_id}/status", response_model=schemas.CustomerOut)
def update_customer_status(
    customer_id: int,
    payload: schemas.CustomerStatusUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = update_customers,
) -> schemas.CustomerOut:
    customer = set_customer_status(
        db,
        customer_id,
        payload.status.value,
        actor=_actor(user),
        user=user,
        extra_values=payload.extra_values,
    )
    return to_customer_out(
        customer
    )


@router.post("/customers/{customer_id}/merge", response_model=schemas.CustomerOut)
def merge_customer(
    customer_id: int,
    payload: schemas.MergeRequest,
    db: Session = Depends(get_db),
    user: CurrentUser = merge_customers,
) -> schemas.CustomerOut:
    target = parties_merge_customers(
        db,
        source_customer_id=customer_id,
        target_customer_id=payload.target_customer_id,
        reason=payload.reason,
        actor=_actor(user),
        user=user,
    )
    return to_customer_out(
        target
    )


# --------------------------------------------------------------------- 客户需求池（CUS-02）
@router.get("/leads", response_model=list[schemas.LeadOut])
def list_leads(
    customer_id: int | None = Query(default=None, gt=0),
    status: str | None = Query(default=None),
    keyword: str | None = Query(default=None, max_length=128),
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> list[schemas.LeadOut]:
    items = parties_list_leads(
        db, customer_id=customer_id, status=status, keyword=keyword, user=user
    )
    return _lead_outputs(db, items)


@router.get("/leads/page", response_model=PageOut[schemas.LeadOut])
def list_leads_page(
    customer_id: int | None = Query(default=None, gt=0),
    status: str | None = Query(default=None),
    keyword: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=10, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> PageOut[schemas.LeadOut]:
    items = parties_list_leads(
        db,
        customer_id=customer_id,
        status=status,
        keyword=keyword,
        user=user,
        limit=limit,
        offset=offset,
    )
    summary = parties_summarize_leads(db, user=user)
    return PageOut(
        items=_lead_outputs(db, items),
        total=summary["total_count"],
        limit=limit,
        offset=offset,
    )


@router.get("/leads/summary", response_model=schemas.LeadSummaryOut)
def lead_summary(
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> schemas.LeadSummaryOut:
    return schemas.LeadSummaryOut(**parties_summarize_leads(db, user=user))


@router.get("/leads/{lead_id}", response_model=schemas.LeadOut)
def get_lead(
    lead_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> schemas.LeadOut:
    return _lead_output(db, parties_get_lead(db, lead_id, user))


@router.post("/leads", response_model=schemas.LeadOut, status_code=201)
def create_lead(
    payload: schemas.LeadCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = create_customers,
) -> schemas.LeadOut:
    owner_id = (
        payload.owner_id
        if user.is_admin or user.owner_scope == "ALL"
        else user.id
    )
    item = parties_create_lead(
        db,
        customer_id=payload.customer_id,
        request_type=payload.request_type.value,
        budget=payload.budget,
        target=payload.target,
        owner_id=owner_id,
        note=payload.note,
        actor=_actor(user),
        user=user,
        extra_values=payload.extra_values,
        operator_user_ids=payload.operator_user_ids,
    )
    return _lead_output(db, item)


@router.patch("/leads/{lead_id}", response_model=schemas.LeadOut)
def update_lead(
    lead_id: int,
    payload: schemas.LeadUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = update_customers,
) -> schemas.LeadOut:
    changes = payload.model_dump(exclude_unset=True)
    operator_user_ids = changes.pop("operator_user_ids", None)
    if "owner_id" in changes and not (user.is_admin or user.owner_scope == "ALL"):
        raise PermissionDenied("只有全量范围用户可以转交需求负责人")
    item = parties_update_lead(
        db,
        lead_id,
        actor=_actor(user),
        user=user,
        operator_user_ids=operator_user_ids,
        **changes,
    )
    return _lead_output(db, item)


@router.post("/leads/{lead_id}/convert", response_model=schemas.LeadOut)
def convert_lead(
    lead_id: int,
    payload: schemas.LeadConvert,
    db: Session = Depends(get_db),
    user: CurrentUser = create_customers,
) -> schemas.LeadOut:
    item = parties_convert_lead(
        db,
        lead_id,
        order_id=payload.order_id,
        actor=_actor(user),
        user=user,
        extra_values=payload.extra_values,
        operator_user_ids=payload.operator_user_ids,
    )
    return _lead_output(db, item)


@router.post("/leads/{lead_id}/close", response_model=schemas.LeadOut)
def close_lead(
    lead_id: int,
    payload: schemas.LeadClose,
    db: Session = Depends(get_db),
    user: CurrentUser = update_customers,
) -> schemas.LeadOut:
    item = parties_close_lead(
        db,
        lead_id,
        reason=payload.reason,
        actor=_actor(user),
        user=user,
        extra_values=payload.extra_values,
        operator_user_ids=payload.operator_user_ids,
    )
    return _lead_output(db, item)


# --------------------------------------------------------------------- 合作方
@router.get("/counterparties", response_model=list[schemas.CounterpartyOut])
def list_counterparties(
    type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = read_counterparties,
) -> list[schemas.CounterpartyOut]:
    items = parties_list_counterparties(db, type=type, status=status)
    extras = get_extra_values_bulk(
        db, entity_type="counterparty", entity_ids=[item.id for item in items]
    )
    return [
        schemas.CounterpartyOut.model_validate(
            to_counterparty_out(
                item, extra_values=extras.get(item.id)
            )
        )
        for item in items
    ]


@router.get("/counterparties/page", response_model=PageOut[schemas.CounterpartyOut])
def list_counterparties_page(
    type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(default=10, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: CurrentUser = read_counterparties,
) -> PageOut[schemas.CounterpartyOut]:
    items = parties_list_counterparties(
        db, type=type, status=status, limit=limit, offset=offset
    )
    extras = get_extra_values_bulk(
        db, entity_type="counterparty", entity_ids=[item.id for item in items]
    )
    return PageOut(
        items=[
            schemas.CounterpartyOut.model_validate(
                to_counterparty_out(item, extra_values=extras.get(item.id))
            )
            for item in items
        ],
        total=parties_count_counterparties(db, type=type, status=status),
        limit=limit,
        offset=offset,
    )


@router.get("/counterparties/{counterparty_id}", response_model=schemas.CounterpartyOut)
def get_counterparty(
    counterparty_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = read_counterparties,
) -> schemas.CounterpartyOut:
    item = parties_get_counterparty(db, counterparty_id)
    return _counterparty_output(db, item)


@router.post("/counterparties", response_model=schemas.CounterpartyOut, status_code=201)
def create_counterparty(
    payload: schemas.CounterpartyCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_counterparties,
) -> schemas.CounterpartyOut:
    item = parties_create_counterparty(
        db,
        display_name=payload.display_name,
        type=payload.type.value,
        actor=_actor(user),
        contact_name=payload.contact_name,
        phone=payload.phone,
        wechat=payload.wechat,
        qq=payload.qq,
        source=payload.source,
        note=payload.note,
        extra_values=payload.extra_values,
    )
    return _counterparty_output(db, item)


@router.patch("/counterparties/{counterparty_id}", response_model=schemas.CounterpartyOut)
def update_counterparty(
    counterparty_id: int,
    payload: schemas.CounterpartyUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_counterparties,
) -> schemas.CounterpartyOut:
    item = parties_update_counterparty(
        db, counterparty_id, actor=_actor(user), **payload.model_dump(exclude_unset=True)
    )
    return _counterparty_output(db, item)


@router.patch(
    "/counterparties/{counterparty_id}/status", response_model=schemas.CounterpartyOut
)
def update_counterparty_status(
    counterparty_id: int,
    active: bool = Query(default=True),
    db: Session = Depends(get_db),
    user: CurrentUser = manage_counterparties,
) -> schemas.CounterpartyOut:
    item = set_counterparty_status(
        db, counterparty_id, active, actor=_actor(user)
    )
    return _counterparty_output(db, item)


__all__ = ["router"]
