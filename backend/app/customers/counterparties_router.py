"""合作方档案 API（BAS-04）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.actor import actor_name as _actor
from app.core.database import get_db
from app.core.schemas import PageOut
from app.core.security import (
    PERM_COUNTERPARTY_MANAGE,
    PERM_COUNTERPARTY_READ,
    CurrentUser,
)
from app.settings.auth.session import require_permissions
from app.customers import schemas
from app.customers._common import to_counterparty_out
from app.customers.counterparties import (
    create_counterparty as parties_create_counterparty,
    count_counterparties as parties_count_counterparties,
    get_counterparty as parties_get_counterparty,
    list_counterparty_options as parties_list_counterparty_options,
    list_counterparties as parties_list_counterparties,
    set_counterparty_status,
    update_counterparty as parties_update_counterparty,
)
from app.customers.counterparty_detail import get_counterparty_detail as parties_get_counterparty_detail
from app.shared.form_values import get_extra_values_bulk
from .router_output import _counterparty_output
from ._filters import created_date_filter

router = APIRouter(tags=["CUS-01 客户与合作方"])

read_counterparties = require_permissions(PERM_COUNTERPARTY_READ)
manage_counterparties = require_permissions(PERM_COUNTERPARTY_MANAGE)


@router.get("/counterparties", response_model=list[schemas.CounterpartyOut])
def list_counterparties(
    type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    created_by: list[str] | None = Query(default=None),
    created_filter: dict = Depends(created_date_filter),
    db: Session = Depends(get_db),
    user: CurrentUser = read_counterparties,
) -> list[schemas.CounterpartyOut]:
    items = parties_list_counterparties(db, type=type, status=status, created_by=created_by, **created_filter)
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
    created_by: list[str] | None = Query(default=None),
    keyword: str | None = Query(default=None, max_length=128),
    sort_desc: bool = Query(default=True),
    limit: int = Query(default=10, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    created_filter: dict = Depends(created_date_filter),
    db: Session = Depends(get_db),
    user: CurrentUser = read_counterparties,
) -> PageOut[schemas.CounterpartyOut]:
    items = parties_list_counterparties(
        db, type=type, status=status, created_by=created_by, keyword=keyword, limit=limit, offset=offset, sort_desc=sort_desc, **created_filter
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
        total=parties_count_counterparties(db, type=type, status=status, created_by=created_by, keyword=keyword, **created_filter),
        limit=limit,
        offset=offset,
    )


@router.get("/counterparties/options", response_model=list[schemas.CounterpartyOptionOut])
def counterparty_options(
    type: str = Query(...),
    keyword: str = Query(default="", max_length=128),
    exact: bool = Query(default=False),
    db: Session = Depends(get_db),
    user: CurrentUser = read_counterparties,
) -> list[schemas.CounterpartyOptionOut]:
    return [schemas.CounterpartyOptionOut.model_validate(item) for item in parties_list_counterparty_options(
        db, type=type, keyword=keyword, exact=exact,
    )]


@router.get("/counterparties/{counterparty_id}", response_model=schemas.CounterpartyOut)
def get_counterparty(
    counterparty_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = read_counterparties,
) -> schemas.CounterpartyOut:
    item = parties_get_counterparty(db, counterparty_id)
    detail = parties_get_counterparty_detail(db, counterparty_id)
    return schemas.CounterpartyOut.model_validate({
        **_counterparty_output(db, item).model_dump(),
        "overview": detail["overview"],
        "orders": detail["orders"],
    })


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
