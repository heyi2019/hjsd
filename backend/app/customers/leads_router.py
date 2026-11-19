"""客户需求池 API（CUS-02）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.actor import actor_name as _actor
from app.core.database import get_db
from app.core.errors import PermissionDenied
from app.core.schemas import PageOut
from app.core.security import (
    PERM_CUSTOMER_CREATE,
    PERM_CUSTOMER_READ,
    PERM_CUSTOMER_UPDATE,
    CurrentUser,
)
from app.settings.auth.session import require_permissions
from app.customers import schemas
from app.customers.leads import (
    close_lead as parties_close_lead,
    convert_lead as parties_convert_lead,
    create_lead as parties_create_lead,
    get_lead as parties_get_lead,
    list_leads as parties_list_leads,
    summarize_leads as parties_summarize_leads,
    update_lead as parties_update_lead,
)
from .router_output import _lead_output, _lead_outputs
from ._filters import created_date_filter

router = APIRouter(tags=["CUS-01 客户与合作方"])

read_customers = require_permissions(PERM_CUSTOMER_READ)
create_customers = require_permissions(PERM_CUSTOMER_CREATE)
update_customers = require_permissions(PERM_CUSTOMER_UPDATE)


@router.get("/leads", response_model=list[schemas.LeadOut])
def list_leads(
    customer_id: int | None = Query(default=None, gt=0),
    status: str | None = Query(default=None),
    keyword: str | None = Query(default=None, max_length=128),
    created_filter: dict = Depends(created_date_filter),
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> list[schemas.LeadOut]:
    items = parties_list_leads(
        db, customer_id=customer_id, status=status, keyword=keyword, user=user, **created_filter
    )
    return _lead_outputs(db, items)


@router.get("/leads/page", response_model=PageOut[schemas.LeadOut])
def list_leads_page(
    customer_id: int | None = Query(default=None, gt=0),
    status: str | None = Query(default=None),
    keyword: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=10, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    created_filter: dict = Depends(created_date_filter),
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
        **created_filter,
    )
    summary = parties_summarize_leads(db, user=user, customer_id=customer_id, status=status, keyword=keyword, **created_filter)
    return PageOut(
        items=_lead_outputs(db, items),
        total=summary["total_count"],
        limit=limit,
        offset=offset,
    )


@router.get("/leads/summary", response_model=schemas.LeadSummaryOut)
def lead_summary(
    created_filter: dict = Depends(created_date_filter),
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> schemas.LeadSummaryOut:
    return schemas.LeadSummaryOut(**parties_summarize_leads(db, user=user, **created_filter))


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
