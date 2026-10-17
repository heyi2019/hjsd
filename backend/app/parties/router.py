"""parties.router：客户、合作方与活字段 API（CUS-01 / BAS-02-05 / BAS-04）。

联系方式默认脱敏；读取完整值须 `customer.contact.read` 且**写审计**；
修改联系方式/备注须 `customer.contact.write`；合并须 `customer.merge`。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.database import get_db
from app.core.errors import PermissionDenied
from app.core.security import (
    PERM_COUNTERPARTY_MANAGE,
    PERM_COUNTERPARTY_READ,
    PERM_CUSTOMER_CONTACT_READ,
    PERM_CUSTOMER_CREATE,
    PERM_CUSTOMER_MERGE,
    PERM_CUSTOMER_READ,
    PERM_CUSTOMER_UPDATE,
    PERM_FIELD_DEFINITION_MANAGE,
    CurrentUser,
    require_permissions,
)
from app.domain.enums import AuditAction
from app.parties import schemas, service

router = APIRouter(tags=["CUS-01 客户与合作方"])

read_customers = require_permissions(PERM_CUSTOMER_READ)
create_customers = require_permissions(PERM_CUSTOMER_CREATE)
update_customers = require_permissions(PERM_CUSTOMER_UPDATE)
merge_customers = require_permissions(PERM_CUSTOMER_MERGE)
read_counterparties = require_permissions(PERM_COUNTERPARTY_READ)
manage_counterparties = require_permissions(PERM_COUNTERPARTY_MANAGE)
manage_fields = require_permissions(PERM_FIELD_DEFINITION_MANAGE)


def _actor(user: CurrentUser) -> str:
    return user.username


# --------------------------------------------------------------------- 客户
@router.get("/customers", response_model=list[schemas.CustomerOut])
def list_customers(
    keyword: str | None = Query(default=None),
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> list[dict]:
    reveal = user.has(PERM_CUSTOMER_CONTACT_READ)
    customers = service.list_customers(db, keyword=keyword, status=status, user=user)
    extras = service.get_extra_values_bulk(
        db, entity_type="customer", entity_ids=[item.id for item in customers]
    )
    activity = service.get_customer_activity_summary(
        db, [item.id for item in customers]
    )
    return [
        service.to_customer_out(
            item,
            reveal_contact=reveal,
            extra_values=extras.get(item.id),
            activity_summary=activity.get(item.id),
        )
        for item in customers
    ]


@router.post(
    "/customers", response_model=schemas.CustomerWithCandidates, status_code=201
)
def create_customer(
    payload: schemas.CustomerCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = create_customers,
) -> dict:
    customer = service.create_customer(
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
    candidates = service.duplicate_candidates(
        db,
        phone=payload.phone,
        wechat=payload.wechat,
        qq=payload.qq,
        exclude_customer_id=customer.id,
        user=user,
    )
    extras = service.get_extra_values(db, entity_type="customer", entity_id=customer.id)
    return {
        "customer": service.to_customer_out(customer, reveal_contact=True, extra_values=extras),
        "duplicate_candidates": candidates,
    }


@router.get("/customers/{customer_id}", response_model=schemas.CustomerOut)
def get_customer(
    customer_id: int,
    reveal: bool = Query(default=False, description="读取完整联系方式，写审计"),
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> dict:
    customer = service.get_customer(db, customer_id, user)
    show_full = reveal and user.has(PERM_CUSTOMER_CONTACT_READ)
    if show_full:
        record_audit(
            db,
            action=AuditAction.CONTACT_READ,
            entity_type="customer",
            entity_id=customer.customer_no,
            actor=_actor(user),
        )
        db.flush()
    extras = service.get_extra_values(db, entity_type="customer", entity_id=customer.id)
    return service.to_customer_out(customer, reveal_contact=show_full, extra_values=extras)


@router.get("/customers/{customer_id}/detail", response_model=schemas.CustomerDetailOut)
def get_customer_detail(
    customer_id: int,
    reveal: bool = Query(default=False, description="读取完整联系方式，写审计"),
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> dict:
    customer = service.get_customer(db, customer_id, user)
    show_full = reveal and user.has(PERM_CUSTOMER_CONTACT_READ)
    if show_full:
        record_audit(
            db,
            action=AuditAction.CONTACT_READ,
            entity_type="customer",
            entity_id=customer.customer_no,
            actor=_actor(user),
        )
    extras = service.get_extra_values(db, entity_type="customer", entity_id=customer.id)
    return {
        "customer": service.to_customer_out(
            customer, reveal_contact=show_full, extra_values=extras
        ),
        **service.get_customer_detail(db, customer_id, user),
    }


@router.patch("/customers/{customer_id}", response_model=schemas.CustomerOut)
def update_customer(
    customer_id: int,
    payload: schemas.CustomerUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = update_customers,
) -> dict:
    customer = service.update_customer(
        db,
        customer_id,
        actor=_actor(user),
        user=user,
        **payload.model_dump(exclude_unset=True),
    )
    extras = service.get_extra_values(db, entity_type="customer", entity_id=customer.id)
    return service.to_customer_out(customer, reveal_contact=True, extra_values=extras)


@router.patch("/customers/{customer_id}/status", response_model=schemas.CustomerOut)
def update_customer_status(
    customer_id: int,
    payload: schemas.CustomerStatusUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = update_customers,
) -> dict:
    customer = service.set_customer_status(
        db,
        customer_id,
        payload.status.value,
        actor=_actor(user),
        user=user,
    )
    return service.to_customer_out(customer, reveal_contact=True)


@router.post("/customers/{customer_id}/merge", response_model=schemas.CustomerOut)
def merge_customer(
    customer_id: int,
    payload: schemas.MergeRequest,
    db: Session = Depends(get_db),
    user: CurrentUser = merge_customers,
) -> dict:
    target = service.merge_customers(
        db,
        source_customer_id=customer_id,
        target_customer_id=payload.target_customer_id,
        reason=payload.reason,
        actor=_actor(user),
        user=user,
    )
    return service.to_customer_out(target, reveal_contact=True)


# --------------------------------------------------------------------- 客户需求池（CUS-02）
@router.get("/leads", response_model=list[schemas.LeadOut])
def list_leads(
    customer_id: int | None = Query(default=None, gt=0),
    status: str | None = Query(default=None),
    keyword: str | None = Query(default=None, max_length=128),
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> list[schemas.LeadOut]:
    return [
        schemas.LeadOut.model_validate(item)
        for item in service.list_leads(
            db, customer_id=customer_id, status=status, keyword=keyword, user=user
        )
    ]


@router.get("/leads/{lead_id}", response_model=schemas.LeadOut)
def get_lead(
    lead_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = read_customers,
) -> schemas.LeadOut:
    return schemas.LeadOut.model_validate(service.get_lead(db, lead_id, user))


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
    item = service.create_lead(
        db,
        customer_id=payload.customer_id,
        request_type=payload.request_type.value,
        budget=payload.budget,
        target=payload.target,
        owner_id=owner_id,
        note=payload.note,
        actor=_actor(user),
        user=user,
    )
    return schemas.LeadOut.model_validate(item)


@router.patch("/leads/{lead_id}", response_model=schemas.LeadOut)
def update_lead(
    lead_id: int,
    payload: schemas.LeadUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = update_customers,
) -> schemas.LeadOut:
    changes = payload.model_dump(exclude_unset=True)
    if "owner_id" in changes and not (user.is_admin or user.owner_scope == "ALL"):
        raise PermissionDenied("只有全量范围用户可以转交需求负责人")
    item = service.update_lead(db, lead_id, actor=_actor(user), user=user, **changes)
    return schemas.LeadOut.model_validate(item)


@router.post("/leads/{lead_id}/convert", response_model=schemas.LeadOut)
def convert_lead(
    lead_id: int,
    payload: schemas.LeadConvert,
    db: Session = Depends(get_db),
    user: CurrentUser = create_customers,
) -> schemas.LeadOut:
    item = service.convert_lead(
        db,
        lead_id,
        order_id=payload.order_id,
        actor=_actor(user),
        user=user,
    )
    return schemas.LeadOut.model_validate(item)


@router.post("/leads/{lead_id}/close", response_model=schemas.LeadOut)
def close_lead(
    lead_id: int,
    payload: schemas.LeadClose,
    db: Session = Depends(get_db),
    user: CurrentUser = update_customers,
) -> schemas.LeadOut:
    item = service.close_lead(
        db,
        lead_id,
        reason=payload.reason,
        actor=_actor(user),
        user=user,
    )
    return schemas.LeadOut.model_validate(item)


# --------------------------------------------------------------------- 合作方
@router.get("/counterparties", response_model=list[schemas.CounterpartyOut])
def list_counterparties(
    type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_counterparties,
) -> list[dict]:
    items = service.list_counterparties(db, type=type, status=status)
    return [
        {
            **{
                key: getattr(item, key)
                for key in (
                    "id",
                    "counterparty_no",
                    "display_name",
                    "type",
                    "contact_name",
                    "phone",
                    "wechat",
                    "qq",
                    "source",
                    "status",
                    "note",
                    "created_at",
                )
            }
        }
        for item in items
    ]


@router.get("/counterparties/{counterparty_id}", response_model=schemas.CounterpartyOut)
def get_counterparty(
    counterparty_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_counterparties,
) -> dict:
    item = service.get_counterparty(db, counterparty_id)
    return schemas.CounterpartyOut.model_validate(item)


@router.post("/counterparties", response_model=schemas.CounterpartyOut, status_code=201)
def create_counterparty(
    payload: schemas.CounterpartyCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_counterparties,
) -> dict:
    item = service.create_counterparty(
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
    )
    return schemas.CounterpartyOut.model_validate(item)


@router.patch("/counterparties/{counterparty_id}", response_model=schemas.CounterpartyOut)
def update_counterparty(
    counterparty_id: int,
    payload: schemas.CounterpartyUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_counterparties,
) -> dict:
    item = service.update_counterparty(
        db, counterparty_id, actor=_actor(user), **payload.model_dump(exclude_unset=True)
    )
    return schemas.CounterpartyOut.model_validate(item)


@router.patch(
    "/counterparties/{counterparty_id}/status", response_model=schemas.CounterpartyOut
)
def update_counterparty_status(
    counterparty_id: int,
    active: bool = Query(default=True),
    db: Session = Depends(get_db),
    user: CurrentUser = manage_counterparties,
) -> dict:
    item = service.set_counterparty_status(
        db, counterparty_id, active, actor=_actor(user)
    )
    return schemas.CounterpartyOut.model_validate(item)


# --------------------------------------------------------------------- 活字段
@router.get("/field-definitions", response_model=list[schemas.FieldDefinitionOut])
def list_field_definitions(
    entity_type: str | None = Query(default=None),
    include_inactive: bool = Query(default=True),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_customers,
) -> list[dict]:
    items = service.list_field_definitions(
        db, entity_type=entity_type, include_inactive=include_inactive
    )
    return [schemas.FieldDefinitionOut.model_validate(item) for item in items]


@router.post(
    "/field-definitions", response_model=schemas.FieldDefinitionOut, status_code=201
)
def create_field_definition(
    payload: schemas.FieldDefinitionCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_fields,
) -> dict:
    item = service.create_field_definition(
        db,
        entity_type=payload.entity_type,
        field_key=payload.field_key,
        label=payload.label,
        actor=_actor(user),
        field_type=payload.field_type,
        options=payload.options,
        required=payload.required,
        sort_order=payload.sort_order,
    )
    return schemas.FieldDefinitionOut.model_validate(item)


@router.patch(
    "/field-definitions/{definition_id}/active",
    response_model=schemas.FieldDefinitionOut,
)
def set_field_definition_active(
    definition_id: int,
    active: bool = Query(default=False),
    db: Session = Depends(get_db),
    user: CurrentUser = manage_fields,
) -> dict:
    item = service.set_field_definition_active(db, definition_id, active, actor=_actor(user))
    return schemas.FieldDefinitionOut.model_validate(item)


@router.delete("/field-definitions/{definition_id}", status_code=204, response_model=None)
def delete_field_definition(
    definition_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = manage_fields,
) -> None:
    """删除字段定义：无历史值才可删；有值返回 409 只能停用（BAS-04-03）。"""
    service.delete_field_definition(db, definition_id, actor=_actor(user))


__all__ = ["router", "get_current_user"]
