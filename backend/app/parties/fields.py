"""parties 实体扩展字段服务。

扩展字段**不单独建表**：
- 定义：就是「客户建档」表单里的**自定义字段**（``order_form_fields``，作用域 ``CUSTOMER``，
  ``is_custom=1``），由设置页「表单字段」维护；
- 值：存在 `customers.form_extra`（JSON 列），与订单 `Order.form_extra` 同构。

因此一个实体一行、一张表，不存在独立的字段定义表或值表。删除字段定义不会连带
删除 `form_extra` 里的历史值（BAS-04-03：有历史值只能停用）。
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import NotFound, Validation
from app.domain.enums import EntityType
from app.domain.parties import Customer
from app.domain.trade import OrderFormField

# 扩展字段定义来源：实体 → 表单作用域码。目前只有客户建档纳入表单字段体系；
# 其余实体的 extra_values 入参保留兼容但不再落库（传入非空即拒绝，与改造前口径一致）。
_EXTRA_DEFINITION_SCOPE = "CUSTOMER"


def _extra_definitions(
    session: Session, entity_type: str, *, required_only: bool = False
) -> list[OrderFormField]:
    """客户扩展字段定义：取自「客户建档」表单的自定义字段。"""
    if entity_type != EntityType.CUSTOMER.value:
        return []
    stmt = select(OrderFormField).where(
        OrderFormField.order_type_code == _EXTRA_DEFINITION_SCOPE,
        OrderFormField.is_custom.is_(True),
        OrderFormField.is_active.is_(True),
    )
    if required_only:
        stmt = stmt.where(OrderFormField.required.is_(True))
    return list(
        session.scalars(stmt.order_by(OrderFormField.sort_order, OrderFormField.id))
    )


def _option_values(definition: OrderFormField) -> list[str]:
    """归一化字段选项：兼容纯字符串数组与 {value,label} 对象数组。"""
    values: list[str] = []
    for item in definition.options or []:
        if isinstance(item, str):
            text = item.strip()
        elif isinstance(item, Mapping):
            text = str(item.get("value") or "").strip()
        else:
            text = ""
        if text:
            values.append(text)
    return values


def _validate_extra_value(definition: OrderFormField, value: Any) -> Any:
    """按字段类型校验扩展值；SELECT/MULTI_SELECT 必须在选项内（BAS-04）。"""
    if value is None:
        return None
    kind = definition.field_type
    if kind == "NUMBER":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise Validation(
                f"字段 {definition.label} 必须为数字",
                details={"field_key": definition.field_key, "value": str(value)[:64]},
            )
        return value
    if kind == "BOOLEAN":
        if not isinstance(value, bool):
            raise Validation(
                f"字段 {definition.label} 必须为布尔值",
                details={"field_key": definition.field_key},
            )
        return value
    if kind == "DATE":
        text = str(value).strip()
        try:
            date.fromisoformat(text)
        except ValueError as exc:
            raise Validation(
                f"字段 {definition.label} 必须为 YYYY-MM-DD 日期",
                details={"field_key": definition.field_key},
            ) from exc
        return text
    if kind == "SELECT":
        if not isinstance(value, str):
            raise Validation(
                f"字段 {definition.label} 必须为字符串",
                details={"field_key": definition.field_key},
            )
        options = _option_values(definition)
        if not options:
            raise Validation(
                f"字段 {definition.label} 未配置有效选项",
                details={"field_key": definition.field_key},
            )
        if value not in options:
            raise Validation(
                f"字段 {definition.label} 的取值必须在选项内",
                details={"field_key": definition.field_key, "value": str(value)[:64]},
            )
        return value
    if kind == "MULTI_SELECT":
        if not isinstance(value, list):
            raise Validation(
                f"字段 {definition.label} 必须为数组",
                details={"field_key": definition.field_key},
            )
        if any(not isinstance(item, str) for item in value):
            raise Validation(
                f"字段 {definition.label} 的选项必须为字符串",
                details={"field_key": definition.field_key},
            )
        options = _option_values(definition)
        if not options:
            raise Validation(
                f"字段 {definition.label} 未配置有效选项",
                details={"field_key": definition.field_key},
            )
        if len(set(value)) != len(value) or any(item not in options for item in value):
            raise Validation(
                f"字段 {definition.label} 的取值必须在选项内",
                details={"field_key": definition.field_key},
            )
        return value
    if kind == "TEXT":
        if not isinstance(value, str):
            raise Validation(
                f"字段 {definition.label} 必须为字符串",
                details={"field_key": definition.field_key},
            )
        return value
    return str(value)


def _validate_required_extras(
    session: Session, entity_type: str, values: Mapping[str, Any], *, partial: bool = False
) -> None:
    """必填扩展字段缺失即拒绝（BAS-04-04）。

    partial=True（更新路径）：只校验**本次提交**涉及到的必填字段非空，
    不要求把历史上已填过的必填字段再交一遍。
    """
    definitions = _extra_definitions(session, entity_type, required_only=True)
    if partial:
        missing = [
            definition.field_key
            for definition in definitions
            if definition.field_key in values and values.get(definition.field_key) in (None, "")
        ]
    else:
        missing = [
            definition.field_key
            for definition in definitions
            if values.get(definition.field_key) in (None, "")
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
) -> dict[str, Any]:
    """按启用定义校验扩展值，返回归一化后的键值对。"""
    definitions = {
        definition.field_key: definition
        for definition in _extra_definitions(session, entity_type)
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
) -> dict[str, Any]:
    """按启用的字段定义写入扩展值；未启用字段拒绝写入（BAS-04-04）。"""
    if isinstance(entity_id, bool) or not isinstance(entity_id, int) or entity_id <= 0:
        raise Validation(
            "实体 ID 必须为正整数",
            details={"field": "entity_id", "entity_type": entity_type, "entity_id": entity_id},
        )
    values = list(values)
    if entity_type != EntityType.CUSTOMER.value:
        # 其余实体尚无扩展字段定义体系：保留入参兼容，非空即拒绝（与改造前一致）。
        if values:
            raise Validation(
                "该实体未启用扩展字段",
                details={"entity_type": entity_type},
            )
        return {}
    customer = session.get(Customer, entity_id)
    if customer is None:
        raise NotFound(
            f"客户 {entity_id} 不存在",
            details={"entity_type": entity_type, "entity_id": entity_id},
        )
    if not values and not require_all:
        return {}
    values_map = {field_key: value for field_key, value in values}
    if len(values_map) != len(values):
        raise Validation("扩展字段不能重复提交", details={"field": "extra_values"})
    if require_all:
        _validate_required_extras(session, entity_type, values_map, partial=False)
    saved = _validate_extra_values(
        session,
        entity_type=entity_type,
        entity_id=entity_id,
        values=values,
    )
    # 并入式写入：只覆盖本次提交的键，未提交的键保留历史值（BAS-04-03）。
    merged = dict(customer.form_extra or {})
    merged.update(saved)
    customer.form_extra = merged
    session.flush()
    return saved


def get_extra_values(session: Session, *, entity_type: str, entity_id: int) -> dict[str, Any]:
    if entity_type != EntityType.CUSTOMER.value:
        return {}
    customer = session.get(Customer, entity_id)
    return dict(customer.form_extra or {}) if customer is not None else {}


def get_extra_values_bulk(
    session: Session, *, entity_type: str, entity_ids: Iterable[int]
) -> dict[int, dict[str, Any]]:
    """批量读取扩展值：列表页一次查询，避免逐行 N+1。"""
    ids = list(entity_ids)
    result: dict[int, dict[str, Any]] = {entity_id: {} for entity_id in ids}
    if not ids or entity_type != EntityType.CUSTOMER.value:
        return result
    rows = session.execute(
        select(Customer.id, Customer.form_extra).where(Customer.id.in_(ids))
    ).all()
    for customer_id, form_extra in rows:
        result[customer_id] = dict(form_extra or {})
    return result


__all__ = [
    "get_extra_values",
    "get_extra_values_bulk",
    "set_extra_values",
]
