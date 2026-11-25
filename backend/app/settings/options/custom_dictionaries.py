"""自定义字典与表单扩展字段的关联；选项仍以字段定义为唯一来源。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core.errors import NotFound, Validation
from app.domain.form_scopes import FORM_SCOPES
from app.domain.options import CUSTOM_DICTIONARY_REGISTRY, OptionSet, custom_dictionary_bindings
from app.domain.trade import OrderFormField
from app.shared.audit import record_audit


def _bindings(row: OptionSet | None) -> list[tuple[int, str]]:
    try:
        return custom_dictionary_bindings(row.options if row is not None else None)
    except ValueError as exc:
        raise Validation(str(exc)) from exc


def _locked_registry(session: Session, *, actor: str) -> OptionSet:
    session.execute(
        pg_insert(OptionSet).values(
            code=CUSTOM_DICTIONARY_REGISTRY, label="自定义字段字典关联", group="SYSTEM",
            editable=False, options=[], created_by=actor, updated_by=actor,
        ).on_conflict_do_nothing(index_elements=["code"])
    )
    row = session.scalar(select(OptionSet).where(OptionSet.code == CUSTOM_DICTIONARY_REGISTRY).with_for_update())
    if row is None:
        raise Validation("自定义字典配置初始化失败")
    return row


def _field_info(field: OrderFormField) -> dict:
    scope_labels = {scope.code: scope.label for scope in FORM_SCOPES}
    return {
        "field_id": field.id,
        "order_type_code": field.order_type_code,
        "field_key": field.field_key,
        "field_label": field.label,
        "scope_label": scope_labels.get(field.order_type_code, field.order_type_code),
        "field_type": field.field_type,
        "is_active": field.is_active,
    }


def list_custom_dictionaries(session: Session) -> dict:
    registry = session.scalar(select(OptionSet).where(OptionSet.code == CUSTOM_DICTIONARY_REGISTRY))
    bindings = _bindings(registry)
    fields = session.scalars(
        select(OrderFormField).where(
            OrderFormField.is_custom.is_(True),
            OrderFormField.field_type.in_(("SELECT", "MULTI_SELECT")),
        ).order_by(OrderFormField.order_type_code, OrderFormField.sort_order, OrderFormField.id)
    ).all()
    by_id = {field.id: field for field in fields}
    linked_ids = {field_id for field_id, _label in bindings}
    items = []
    for field_id, label in bindings:
        field = by_id.get(field_id)
        info = _field_info(field) if field else {
            "field_id": field_id, "order_type_code": "", "field_key": "", "field_label": "关联字段不可用",
            "scope_label": "未知", "field_type": "", "is_active": False,
        }
        items.append({**info, "label": label})
    return {"items": items, "available_fields": [_field_info(field) for field in fields if field.id not in linked_ids]}


def create_custom_dictionary(session: Session, *, field_id: int, label: str, actor: str) -> dict:
    field = session.scalar(select(OrderFormField).where(OrderFormField.id == field_id).with_for_update())
    if field is None or not field.is_custom or field.field_type not in {"SELECT", "MULTI_SELECT"}:
        raise Validation("请选择已有的自定义单选或多选字段")
    registry = _locked_registry(session, actor=actor)
    bindings = _bindings(registry)
    if any(existing_id == field_id for existing_id, _ in bindings):
        raise Validation("该扩展字段已关联字典")
    registry.options = [*(registry.options or []), {"value": str(field_id), "label": label}]
    registry.updated_by = actor
    record_audit(session, action="OPTION_SET_CREATE", entity_type="option_set", entity_id=CUSTOM_DICTIONARY_REGISTRY,
                 actor=actor, after={"field_id": field_id, "label": label, "scope": field.order_type_code})
    session.flush()
    return {**_field_info(field), "label": label}


def delete_custom_dictionary(session: Session, *, field_id: int, actor: str) -> None:
    registry = session.scalar(select(OptionSet).where(OptionSet.code == CUSTOM_DICTIONARY_REGISTRY).with_for_update())
    bindings = _bindings(registry)
    found = next((label for existing_id, label in bindings if existing_id == field_id), None)
    if registry is None or found is None:
        raise NotFound("自定义字典不存在")
    registry.options = [item for item in (registry.options or []) if int(item["value"]) != field_id]
    registry.updated_by = actor
    record_audit(session, action="OPTION_SET_DELETE", entity_type="option_set", entity_id=CUSTOM_DICTIONARY_REGISTRY,
                 actor=actor, before={"field_id": field_id, "label": found})
    session.flush()
