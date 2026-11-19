"""客户档案 API（CUS-01）。

联系方式直接返回档案原值；修改联系方式/备注须 `customer.contact.write`；合并须 `customer.merge`。
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.core.actor import actor_name as _actor
from app.shared.audit import record_audit
from app.core.database import get_db
from app.core.errors import Validation
from app.core.schemas import PageOut
from app.core.security import (
    PERM_CUSTOMER_CREATE,
    PERM_CUSTOMER_MERGE,
    PERM_CUSTOMER_READ,
    PERM_CUSTOMER_UPDATE,
    CurrentUser,
)
from app.settings.auth.session import require_permissions
from app.domain.enums import AuditAction
from app.settings.lists.export import EXPORT_ROW_LIMIT, build_list_csv
from app.settings.lists.file_response import CSV_MEDIA_TYPE, file_response
from app.customers import schemas
from app.customers._common import to_customer_out
from app.customers._filters import created_date_filter
from app.customers.customer_detail import get_customer_activity_summary
from app.customers.customer_merge import (
    duplicate_candidates,
    merge_customers as parties_merge_customers,
)
from app.customers.customers import (
    count_customers,
    create_customer as parties_create_customer,
    get_customer as parties_get_customer,
    list_customers as parties_list_customers,
    set_customer_status,
    summarize_customers as parties_summarize_customers,
    update_customer as parties_update_customer,
)
from app.shared.form_values import get_extra_values, get_extra_values_bulk
from app.customers.customer_detail import get_customer_detail as parties_get_customer_detail

router = APIRouter(tags=["CUS-01 客户与合作方"])

read_customers = require_permissions(PERM_CUSTOMER_READ)
create_customers = require_permissions(PERM_CUSTOMER_CREATE)
update_customers = require_permissions(PERM_CUSTOMER_UPDATE)
merge_customers = require_permissions(PERM_CUSTOMER_MERGE)


def mine_order_filter(
    mine_orders: bool = Query(default=False),
    trade_date_from: date | None = Query(default=None),
    trade_date_to: date | None = Query(default=None),
) -> dict:
    if mine_orders and ((trade_date_from is None) != (trade_date_to is None) or (trade_date_from is not None and trade_date_to is not None and trade_date_from > trade_date_to)):
        raise Validation("请选择有效的订单日期范围")
    return {"mine_orders": mine_orders, "trade_date_from": trade_date_from, "trade_date_to": trade_date_to}


@router.get("/customers", response_model=PageOut[schemas.CustomerOut])
def list_customers(
    keyword: str | None = Query(default=None),
    status: str | None = Query(default=None),
    created_by: list[str] | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    order_filter: dict = Depends(mine_order_filter),
    created_filter: dict = Depends(created_date_filter),
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> PageOut[schemas.CustomerOut]:
    customers = parties_list_customers(
        db, keyword=keyword, status=status, created_by=created_by, user=user, limit=limit, offset=offset, **order_filter, **created_filter
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
        total=count_customers(db, keyword=keyword, status=status, created_by=created_by, user=user, **order_filter, **created_filter),
        limit=limit,
        offset=offset,
    )


@router.get("/customers/summary", response_model=schemas.CustomerSummaryOut)
def customer_summary(
    today_date: date = Query(...),
    keyword: str | None = Query(default=None),
    status: str | None = Query(default=None),
    created_by: list[str] | None = Query(default=None),
    order_filter: dict = Depends(mine_order_filter),
    created_filter: dict = Depends(created_date_filter),
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> schemas.CustomerSummaryOut:
    return schemas.CustomerSummaryOut(**parties_summarize_customers(
        db, today_date=today_date, keyword=keyword, status=status, created_by=created_by, user=user, **order_filter, **created_filter
    ))


@router.get("/customers/export.csv")
def export_customers_csv(
    keyword: str | None = Query(default=None),
    status: str | None = Query(default=None),
    created_by: list[str] | None = Query(default=None),
    order_filter: dict = Depends(mine_order_filter),
    created_filter: dict = Depends(created_date_filter),
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> Response:
    """客户按可见列导出 CSV：同 /customers 筛选口径，上限 EXPORT_ROW_LIMIT。"""
    customers = parties_list_customers(
        db, keyword=keyword, status=status, created_by=created_by, user=user, limit=EXPORT_ROW_LIMIT, offset=0, **order_filter, **created_filter
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
