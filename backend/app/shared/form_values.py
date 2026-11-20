"""customer_center 实体扩展字段服务。

扩展字段**不单独建表**：
- 定义：就是「客户建档」表单里的**自定义字段**（``order_form_fields``，作用域 ``CUSTOMER``，
  ``is_custom=1``），由设置页「表单字段」维护；
- 值：按实体存放在对应实体的 `form_extra`（JSON 列），账号与订单、客户各自独立。

因此一个实体一行、一张表，不存在独立的字段定义表或值表。删除字段定义不会连带
删除 `form_extra` 里的历史值（BAS-04-03：有历史值只能停用）。
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import NotFound, Validation
from app.domain.parties import Counterparty, Customer, CustomerLead
from app.domain.trade import Account, OrderFormField
from app.shared.form_field_value import _option_values as _shared_option_values
from app.shared.form_field_value import field_is_required, has_field_value, validate_field_value

# 客户字段定义来自 CUSTOMER 作用域；建单账号字段由订单字段配置筛选后写入账号扩展 JSON。
_EXTRA_DEFINITION_SCOPES: dict[str, tuple[str, ...]] = {
    "customer": ("CUSTOMER",),
    "lead": ("LEAD", "LEADCLOSE", "LEADCONVERT"),
    "counterparty": ("COUNTERPARTY",),
    # 账号/产品字段在四种建单表单中复用；只取账号/产品板块的自定义项。
    "account": ("HS", "TH", "DG"),
}
_EXTRA_ENTITY_MODELS: dict[str, type] = {
    "customer": Customer,
    "lead": CustomerLead,
    "counterparty": Counterparty,
    "account": Account,
}


def _extra_definitions(
    session: Session, entity_type: str, *, required_only: bool = False, scope: str | None = None
) -> list[OrderFormField]:
    """按实体取设置页对应作用域的自定义字段定义。"""
    scopes = _EXTRA_DEFINITION_SCOPES.get(entity_type)
    if not scopes:
        return []
    if scope is not None:
        if scope not in scopes:
            raise Validation("字段作用域与实体不匹配", details={"entity_type": entity_type, "scope": scope})
        scopes = (scope,)
    stmt = select(OrderFormField).where(
        OrderFormField.order_type_code.in_(scopes),
        OrderFormField.is_custom.is_(True),
        OrderFormField.is_active.is_(True),
    )
    if entity_type == "account":
        stmt = stmt.where(OrderFormField.section == "ACCOUNT_PRODUCT")
    if required_only:
        stmt = stmt.where(OrderFormField.required.is_(True))
    return list(
        session.scalars(stmt.order_by(OrderFormField.sort_order, OrderFormField.id))
    )


def _option_values(definition: OrderFormField) -> list[str]:
    """读取规范化后的字段选项对象（严格域口径，委托共享原语）。"""
    return _shared_option_values(definition, strict=True)


def _validate_extra_value(definition: OrderFormField, value: Any) -> Any:
    """按字段类型严格校验扩展值（BAS-04），委托跨域唯一原语。"""
    return validate_field_value(definition, value, strict=True)


def _validate_required_extras(
    session: Session, entity_type: str, values: Mapping[str, Any], *, partial: bool = False, scope: str | None = None
) -> None:
    """必填扩展字段缺失即拒绝（BAS-04-04）。

    partial=True（更新路径）：只校验**本次提交**涉及到的必填字段非空，
    不要求把历史上已填过的必填字段再交一遍。
    """
    definitions = _extra_definitions(session, entity_type, scope=scope)
    missing = [
        definition.field_key
        for definition in definitions
        if (not partial or definition.field_key in values)
        # 账号字段的条件依赖可能属于订单其他板块，已在建单时按完整表单校验。
        and (definition.required if entity_type == "account" else field_is_required(definition, values))
        and not has_field_value(values.get(definition.field_key))
    ]
    if missing:
        raise Validation(
            f"必填扩展字段未填写：{', '.join(missing)}",
            details={"fields": missing},
        )


def _validate_extra_values(
    session: Session,
    *,
    entity_type: str,
    entity_id: int | None,
    values: Iterable[tuple[str, Any]],
    scope: str | None = None,
) -> dict[str, Any]:
    """按启用定义校验扩展值，返回归一化后的键值对。"""
    definitions = {
        definition.field_key: definition
        for definition in _extra_definitions(session, entity_type, scope=scope)
    }
    validated: dict[str, Any] = {}
    for field_key, value in values:
        definition = definitions.get(field_key)
        if definition is None:
            raise Validation(
                f"字段 {field_key} 未启用或不存在",
                details={"entity_type": entity_type, "entity_id": entity_id, "field_key": field_key},
            )
        validated[field_key] = _validate_extra_value(definition, value)
    return validated


def set_extra_values(
    session: Session,
    *,
    entity_type: str,
    entity_id: int,
    values: Iterable[tuple[str, Any]],
    require_all: bool = False,
    scope: str | None = None,
) -> dict[str, Any]:
    """按启用的字段定义写入扩展值；未启用字段拒绝写入（BAS-04-04）。"""
    if isinstance(entity_id, bool) or not isinstance(entity_id, int) or entity_id <= 0:
        raise Validation(
            "实体 ID 必须为正整数",
            details={"field": "entity_id", "entity_type": entity_type, "entity_id": entity_id},
        )
    values = list(values)
    model = _EXTRA_ENTITY_MODELS.get(entity_type)
    if model is None:
        if values:
            raise Validation("该实体未启用扩展字段", details={"entity_type": entity_type})
        return {}
    entity = session.get(model, entity_id)
    if entity is None:
        label = {"account": "账号", "customer": "客户", "lead": "需求", "counterparty": "合作方"}.get(entity_type, "实体")
        raise NotFound(f"{label} {entity_id} 不存在", details={"entity_type": entity_type, "entity_id": entity_id})
    values_map = {field_key: value for field_key, value in values}
    if len(values_map) != len(values):
        raise Validation("扩展字段不能重复提交", details={"field": "extra_values"})
    if require_all:
        _validate_required_extras(session, entity_type, values_map, partial=False, scope=scope)
    saved = _validate_extra_values(
        session, entity_type=entity_type, entity_id=entity_id, values=values, scope=scope
    )
    merged = dict(entity.form_extra or {})
    for field_key, value in saved.items():
        if value is None or value == "" or value == []:
            merged.pop(field_key, None)
        else:
            merged[field_key] = value
    entity.form_extra = merged
    session.flush()
    return saved


def get_extra_values(session: Session, *, entity_type: str, entity_id: int) -> dict[str, Any]:
    model = _EXTRA_ENTITY_MODELS.get(entity_type)
    if model is None:
        return {}
    entity = session.get(model, entity_id)
    return dict(entity.form_extra or {}) if entity is not None else {}


def get_extra_values_bulk(
    session: Session, *, entity_type: str, entity_ids: Iterable[int]
) -> dict[int, dict[str, Any]]:
    """批量读取扩展值：列表页一次查询，避免逐行 N+1。"""
    ids = list(entity_ids)
    result: dict[int, dict[str, Any]] = {entity_id: {} for entity_id in ids}
    if not ids or entity_type not in _EXTRA_ENTITY_MODELS:
        return result
    model = _EXTRA_ENTITY_MODELS[entity_type]
    rows = session.execute(select(model.id, model.form_extra).where(model.id.in_(ids))).all()
    for customer_id, form_extra in rows:
        result[customer_id] = dict(form_extra or {})
    return result


__all__ = [
    "get_extra_values",
    "get_extra_values_bulk",
    "set_extra_values",
]
