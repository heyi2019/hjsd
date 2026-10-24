"""parties 动态字段定义与实体扩展值服务。"""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from datetime import date
from typing import Any

from sqlalchemy import func, inspect, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.domain.enums import AuditAction, EntityType, FieldType
from app.domain.parties import EntityExtraValue, FieldDefinition
from app.domain.trade import Order

from ._common import (
    FIELD_KEY_PATTERN,
    ORDER_TYPE_CODE_PATTERN,
    _ENTITY_LABELS,
    _EXTRA_ENTITY_MODELS,
    _UNSET,
    _fixed_entity_fields,
    _required_bool,
    _required_text,
)
# --------------------------------------------------------------------- 活字段
def _normalize_field_options(
    field_type: str, options: Sequence[str] | None
) -> list[str]:
    """规范化字段选项，避免选择型字段退化成无约束文本。"""
    if options is None:
        raw: list[Any] = []
    elif isinstance(options, (str, bytes)):
        raise Validation("字段选项必须为字符串数组", details={"field": "options"})
    else:
        raw = list(options)

    if field_type not in (FieldType.SELECT.value, FieldType.MULTI_SELECT.value):
        if raw:
            raise Validation(
                "非选择型字段不能配置选项", details={"field": "options"}
            )
        return []

    normalized: list[str] = []
    for option in raw:
        if not isinstance(option, str) or not option.strip():
            raise Validation(
                "字段选项必须为非空字符串",
                details={"field": "options", "value": str(option)[:64]},
            )
        normalized.append(option.strip())
    if not normalized:
        raise Validation(
            "选择型字段至少需要一个选项", details={"field": "options"}
        )
    if len(set(normalized)) != len(normalized):
        raise Validation("字段选项不能重复", details={"field": "options"})
    return normalized


def _normalize_applicable_order_types(
    value: Sequence[str] | None,
) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, (str, bytes)):
        raise Validation(
            "适用业务类型必须为字符串数组",
            details={"field": "applicable_order_types"},
        )
    normalized = []
    for item in value:
        code = item.strip().upper() if isinstance(item, str) else ""
        if not ORDER_TYPE_CODE_PATTERN.fullmatch(code):
            raise Validation(
                "适用业务类型必须为 2-10 位大写字母或数字",
                details={"field": "applicable_order_types", "value": item},
            )
        normalized.append(code)
    if len(set(normalized)) != len(normalized):
        raise Validation(
            "适用业务类型不能重复",
            details={"field": "applicable_order_types"},
        )
    return normalized


def _normalize_validation_rule(
    field_type: str, value: Mapping[str, Any] | None
) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise Validation("校验规则必须为对象", details={"field": "validation_rule"})
    allowed = {"min", "max", "min_length", "max_length", "pattern"}
    unknown = set(value) - allowed
    if unknown:
        raise Validation(
            "校验规则包含不支持的键",
            details={"field": "validation_rule", "keys": sorted(unknown)},
        )
    rule = dict(value)
    if field_type == FieldType.NUMBER.value:
        for key in ("min", "max"):
            if key in rule and (
                isinstance(rule[key], bool) or not isinstance(rule[key], (int, float))
            ):
                raise Validation(
                    f"校验规则 {key} 必须为数字",
                    details={"field": f"validation_rule.{key}"},
                )
        if "min" in rule and "max" in rule and rule["min"] > rule["max"]:
            raise Validation("校验规则最小值不能大于最大值")
    for key in ("min_length", "max_length"):
        if key in rule and (
            isinstance(rule[key], bool)
            or not isinstance(rule[key], int)
            or rule[key] < 0
        ):
            raise Validation(
                f"校验规则 {key} 必须为非负整数",
                details={"field": f"validation_rule.{key}"},
            )
    if "min_length" in rule and "max_length" in rule and rule["min_length"] > rule["max_length"]:
        raise Validation("校验规则最小长度不能大于最大长度")
    if "pattern" in rule:
        if not isinstance(rule["pattern"], str) or not rule["pattern"]:
            raise Validation("校验规则 pattern 必须为非空字符串")
        try:
            re.compile(rule["pattern"])
        except re.error as exc:
            raise Validation("校验规则 pattern 不是有效正则表达式") from exc
    if field_type != FieldType.NUMBER.value and any(key in rule for key in ("min", "max")):
        raise Validation("只有数字字段可以配置 min/max")
    if field_type != FieldType.TEXT.value and any(
        key in rule for key in ("min_length", "max_length", "pattern")
    ):
        raise Validation("只有文本字段可以配置长度或 pattern 校验")
    return rule


def _validate_extra_value(definition: FieldDefinition, value: Any) -> Any:
    """按字段类型校验活字段值；SELECT/MULTI_SELECT 必须在选项内（BAS-04）。"""
    if value is None:
        return None
    kind = definition.field_type
    if kind == "NUMBER":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise Validation(
                f"字段 {definition.label} 必须为数字",
                details={"field_key": definition.field_key, "value": str(value)[:64]},
            )
        rule = definition.validation_rule or {}
        if "min" in rule and value < rule["min"]:
            raise Validation(
                f"字段 {definition.label} 不能小于 {rule['min']}",
                details={"field_key": definition.field_key},
            )
        if "max" in rule and value > rule["max"]:
            raise Validation(
                f"字段 {definition.label} 不能大于 {rule['max']}",
                details={"field_key": definition.field_key},
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
        options = list(definition.options or [])
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
        options = list(definition.options or [])
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
        rule = definition.validation_rule or {}
        if "min_length" in rule and len(value) < rule["min_length"]:
            raise Validation(
                f"字段 {definition.label} 长度不能少于 {rule['min_length']}",
                details={"field_key": definition.field_key},
            )
        if "max_length" in rule and len(value) > rule["max_length"]:
            raise Validation(
                f"字段 {definition.label} 长度不能超过 {rule['max_length']}",
                details={"field_key": definition.field_key},
            )
        if "pattern" in rule and re.fullmatch(rule["pattern"], value) is None:
            raise Validation(
                f"字段 {definition.label} 格式不符合要求",
                details={"field_key": definition.field_key},
            )
        return value
    return str(value)


def _validate_extra_values(
    session: Session,
    *,
    entity_type: str,
    entity_id: int | None,
    values: Iterable[tuple[str, Any]],
) -> list[tuple[str, FieldDefinition, Any]]:
    if entity_type not in _EXTRA_ENTITY_MODELS:
        raise Validation(
            f"实体类型必须为 {EntityType.values()}",
            details={"field": "entity_type", "value": entity_type},
        )
    if entity_id is not None and (
        isinstance(entity_id, bool) or not isinstance(entity_id, int) or entity_id <= 0
    ):
        raise Validation(
            "实体 ID 必须为正整数",
            details={"field": "entity_id", "entity_type": entity_type, "entity_id": entity_id},
        )
    model = _EXTRA_ENTITY_MODELS[entity_type]
    entity = session.get(model, entity_id) if entity_id is not None else None
    if entity_id is not None and entity is None:
        raise NotFound(
            f"{_ENTITY_LABELS[entity_type]} {entity_id} 不存在",
            details={"entity_type": entity_type, "entity_id": entity_id},
        )

    validated: list[tuple[str, FieldDefinition, Any]] = []
    for field_key, value in values:
        definition = session.scalar(
            select(FieldDefinition).where(
                FieldDefinition.entity_type == entity_type,
                FieldDefinition.field_key == field_key,
                FieldDefinition.is_active.is_(True),
            )
        )
        if definition is None:
            raise Validation(
                f"字段 {field_key} 未启用或不存在",
                details={"entity_type": entity_type, "field_key": field_key},
            )
        applicable = definition.applicable_order_types or []
        if applicable and entity is not None:
            order_type = None
            if entity_type == EntityType.ORDER.value:
                order_type = entity.order_type
            elif entity_type == EntityType.INSTALLMENT.value:
                order = session.get(Order, entity.order_id)
                order_type = order.order_type if order is not None else None
            elif entity_type == EntityType.ACCOUNT.value:
                order = session.scalar(
                    select(Order)
                    .where(Order.account_id == entity.id)
                    .order_by(Order.id.desc())
                )
                order_type = order.order_type if order is not None else None
            if order_type is not None and order_type not in applicable:
                raise Validation(
                    f"字段 {definition.label} 不适用于业务 {order_type}",
                    details={
                        "entity_type": entity_type,
                        "field_key": field_key,
                        "order_type": order_type,
                        "applicable_order_types": applicable,
                    },
                )
        validated.append(
            (field_key, definition, _validate_extra_value(definition, value))
        )
    return validated


def _validate_required_extras(
    session: Session, entity_type: str, values: Mapping[str, Any], *, partial: bool = False
) -> None:
    """必填活字段缺失即拒绝（BAS-04-04）。

    partial=True（更新路径）：只校验**本次提交**涉及到的必填字段非空，
    不要求把历史上已填过的必填字段再交一遍。
    """
    definitions = session.scalars(
        select(FieldDefinition).where(
            FieldDefinition.entity_type == entity_type,
            FieldDefinition.required.is_(True),
            FieldDefinition.is_active.is_(True),
        )
    ).all()
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
            f"必填活字段未填写：{', '.join(missing)}",
            details={"fields": missing},
        )


def create_field_definition(
    session: Session,
    *,
    entity_type: str,
    field_key: str,
    label: str,
    actor: str,
    field_type: str = "TEXT",
    options: Sequence[str] | None = None,
    default_value: Any = None,
    applicable_order_types: Sequence[str] | None = None,
    validation_rule: Mapping[str, Any] | None = None,
    required: bool = False,
    sort_order: int = 0,
) -> FieldDefinition:
    entity = _required_text(
        entity_type, message=f"实体类型必须为 {EntityType.values()}", field="entity_type"
    ).lower()
    if entity not in EntityType.values():
        raise Validation(
            f"实体类型必须为 {EntityType.values()}",
            details={"field": "entity_type", "value": entity_type},
        )
    if not isinstance(field_type, str) or field_type not in FieldType.values():
        raise Validation(
            f"字段类型必须为 {FieldType.values()}",
            details={"field": "field_type", "value": field_type},
        )
    if isinstance(sort_order, bool) or not isinstance(sort_order, int):
        raise Validation(
            "排序值必须为整数",
            details={"field": "sort_order", "value": sort_order},
        )
    if sort_order < 0:
        raise Validation(
            "排序值不能为负数",
            details={"field": "sort_order", "value": sort_order},
        )
    normalized_options = _normalize_field_options(field_type, options)
    normalized_applicable = _normalize_applicable_order_types(applicable_order_types)
    normalized_rule = _normalize_validation_rule(field_type, validation_rule)
    key = _required_text(
        field_key,
        message="字段键必须为小写字母开头，仅含小写字母、数字与下划线",
        field="field_key",
    )
    if not FIELD_KEY_PATTERN.match(key):
        raise Validation(
            "字段键必须为小写字母开头，仅含小写字母、数字与下划线",
            details={"field": "field_key", "value": field_key},
        )
    if key in _fixed_entity_fields(entity):
        raise Validation(
            f"活字段不能覆盖固定字段 {key}",
            details={"entity_type": entity, "field_key": key},
        )
    exists = session.scalar(
        select(FieldDefinition).where(
            FieldDefinition.entity_type == entity, FieldDefinition.field_key == key
        )
    )
    if exists is not None:
        raise Conflict(
            f"字段 {key} 已存在",
            code=ErrorCode.DUPLICATE_CODE,
            details={"entity_type": entity, "field_key": key},
        )

    normalized_label = _required_text(
        label, message="字段名称不能为空", field="label"
    )

    definition = FieldDefinition(
        entity_type=entity,
        field_key=key,
        label=normalized_label,
        field_type=field_type,
        options=normalized_options,
        default_value=default_value,
        applicable_order_types=normalized_applicable,
        validation_rule=normalized_rule,
        required=required,
        sort_order=sort_order,
        is_active=True,
        created_by=actor,
        updated_by=actor,
    )
    if default_value is not None:
        definition.default_value = _validate_extra_value(definition, default_value)
    session.add(definition)
    session.flush()
    record_audit(
        session,
        action=AuditAction.FIELD_DEFINITION_CHANGE,
        entity_type="field_definition",
        entity_id=f"{entity}.{key}",
        actor=actor,
        after={"label": label, "is_active": True},
    )
    return definition


def update_field_definition(
    session: Session,
    definition_id: int,
    *,
    actor: str,
    label: str | None = None,
    options: Sequence[str] | None | object = _UNSET,
    default_value: Any = _UNSET,
    applicable_order_types: Sequence[str] | None | object = _UNSET,
    validation_rule: Mapping[str, Any] | None | object = _UNSET,
    required: bool | None = None,
    sort_order: int | None = None,
) -> FieldDefinition:
    """编辑活字段定义；键、实体和类型固定，避免历史值失去语义。"""
    definition = session.get(FieldDefinition, definition_id)
    if definition is None:
        raise NotFound(
            f"字段定义 {definition_id} 不存在",
            details={"field_definition_id": definition_id},
        )
    next_label = (
        _required_text(label, message="字段名称不能为空", field="label")
        if label is not None
        else definition.label
    )
    next_options = (
        _normalize_field_options(definition.field_type, options)
        if options is not _UNSET
        else list(definition.options or [])
    )
    next_applicable = (
        _normalize_applicable_order_types(applicable_order_types)
        if applicable_order_types is not _UNSET
        else definition.applicable_order_types
    )
    next_rule = (
        _normalize_validation_rule(definition.field_type, validation_rule)
        if validation_rule is not _UNSET
        else definition.validation_rule
    )
    next_default = definition.default_value if default_value is _UNSET else default_value
    candidate = FieldDefinition(
        entity_type=definition.entity_type,
        field_key=definition.field_key,
        label=next_label,
        field_type=definition.field_type,
        options=next_options,
        default_value=next_default,
        applicable_order_types=next_applicable,
        validation_rule=next_rule,
        required=definition.required if required is None else required,
        sort_order=definition.sort_order if sort_order is None else sort_order,
        is_active=definition.is_active,
    )
    if candidate.default_value is not None:
        candidate.default_value = _validate_extra_value(candidate, candidate.default_value)
    if candidate.required and candidate.default_value is None:
        # 继续允许无默认值的必填字段，表单创建时统一校验缺失。
        pass
    before = {
        "label": definition.label,
        "options": definition.options,
        "default_value": definition.default_value,
        "applicable_order_types": definition.applicable_order_types,
        "validation_rule": definition.validation_rule,
        "required": definition.required,
        "sort_order": definition.sort_order,
    }
    definition.label = candidate.label
    definition.options = candidate.options
    definition.default_value = candidate.default_value
    definition.applicable_order_types = candidate.applicable_order_types
    definition.validation_rule = candidate.validation_rule
    if required is not None:
        if not isinstance(required, bool):
            raise Validation("required 必须为布尔值", details={"field": "required"})
        definition.required = required
    if sort_order is not None:
        if isinstance(sort_order, bool) or not isinstance(sort_order, int) or sort_order < 0:
            raise Validation("排序值必须为非负整数", details={"field": "sort_order"})
        definition.sort_order = sort_order
    definition.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.FIELD_DEFINITION_CHANGE,
        entity_type="field_definition",
        entity_id=f"{definition.entity_type}.{definition.field_key}",
        actor=actor,
        before=before,
        after={
            "label": definition.label,
            "options": definition.options,
            "default_value": definition.default_value,
            "applicable_order_types": definition.applicable_order_types,
            "validation_rule": definition.validation_rule,
            "required": definition.required,
            "sort_order": definition.sort_order,
        },
    )
    return definition


def list_field_definitions(
    session: Session, *, entity_type: str | None = None, include_inactive: bool = True
) -> list[FieldDefinition]:
    stmt = select(FieldDefinition)
    if entity_type:
        stmt = stmt.where(FieldDefinition.entity_type == entity_type)
    if not include_inactive:
        stmt = stmt.where(FieldDefinition.is_active.is_(True))
    return list(session.scalars(stmt.order_by(FieldDefinition.sort_order, FieldDefinition.id)))


def set_field_definition_active(
    session: Session, definition_id: int, active: bool, *, actor: str
) -> FieldDefinition:
    """停用后历史值仍显示，新建表单不可填（A10）。"""
    active = _required_bool(active, field="active")
    definition = session.get(FieldDefinition, definition_id)
    if definition is None:
        raise NotFound(
            f"字段定义 {definition_id} 不存在", details={"field_definition_id": definition_id}
        )
    before = definition.is_active
    definition.is_active = active
    definition.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.FIELD_DEFINITION_CHANGE,
        entity_type="field_definition",
        entity_id=f"{definition.entity_type}.{definition.field_key}",
        actor=actor,
        before={"is_active": before},
        after={"is_active": active},
    )
    return definition


def set_extra_values(
    session: Session,
    *,
    entity_type: str,
    entity_id: int,
    values: Iterable[tuple[str, Any]],
    require_all: bool = False,
) -> dict[str, Any]:
    """按启用的字段定义写入活字段值；未启用字段拒绝写入（BAS-04-04）。"""
    values = list(values)
    # 初始 Alembic 迁移会先种子资金池，再创建活字段表；没有提交活字段值时，
    # 不能在表尚未存在的阶段查询定义。正常业务库仍会执行必填字段校验。
    if not values and not inspect(session.get_bind()).has_table("field_definitions"):
        return {}
    values_map = {field_key: value for field_key, value in values}
    if len(values_map) != len(values):
        raise Validation(
            "活字段不能重复提交",
            details={"field": "extra_values"},
        )
    if require_all:
        definitions = session.scalars(
            select(FieldDefinition).where(
                FieldDefinition.entity_type == entity_type,
                FieldDefinition.is_active.is_(True),
            )
        ).all()
        for definition in definitions:
            if definition.field_key not in values_map and definition.default_value is not None:
                values_map[definition.field_key] = definition.default_value
        values = list(values_map.items())
        _validate_required_extras(
            session, entity_type, values_map, partial=False
        )
    validated = _validate_extra_values(
        session,
        entity_type=entity_type,
        entity_id=entity_id,
        values=values,
    )

    saved: dict[str, Any] = {}
    for field_key, definition, normalized_value in validated:
        row = session.scalar(
            select(EntityExtraValue).where(
                EntityExtraValue.entity_type == entity_type,
                EntityExtraValue.entity_id == entity_id,
                EntityExtraValue.field_definition_id == definition.id,
            )
        )
        if row is None:
            row = EntityExtraValue(
                entity_type=entity_type,
                entity_id=entity_id,
                field_definition_id=definition.id,
                value={"value": normalized_value},
            )
            session.add(row)
        else:
            row.value = {"value": normalized_value}
        saved[field_key] = normalized_value
    session.flush()
    return saved


def get_extra_values(session: Session, *, entity_type: str, entity_id: int) -> dict[str, Any]:
    rows = session.scalars(
        select(EntityExtraValue).where(
            EntityExtraValue.entity_type == entity_type,
            EntityExtraValue.entity_id == entity_id,
        )
    ).all()
    result: dict[str, Any] = {}
    for row in rows:
        definition = session.get(FieldDefinition, row.field_definition_id)
        if definition is not None:
            result[definition.field_key] = (row.value or {}).get("value")
    return result


def get_extra_values_bulk(
    session: Session, *, entity_type: str, entity_ids: Iterable[int]
) -> dict[int, dict[str, Any]]:
    """批量读取活字段值：列表页一次查询，避免逐行 N+1。"""
    ids = list(entity_ids)
    result: dict[int, dict[str, Any]] = {entity_id: {} for entity_id in ids}
    if not ids:
        return result
    rows = session.scalars(
        select(EntityExtraValue).where(
            EntityExtraValue.entity_type == entity_type,
            EntityExtraValue.entity_id.in_(ids),
        )
    ).all()
    if not rows:
        return result
    definitions = session.scalars(
        select(FieldDefinition).where(
            FieldDefinition.id.in_({row.field_definition_id for row in rows})
        )
    ).all()
    key_by_id = {definition.id: definition.field_key for definition in definitions}
    for row in rows:
        field_key = key_by_id.get(row.field_definition_id)
        if field_key is not None:
            result.setdefault(row.entity_id, {})[field_key] = (row.value or {}).get("value")
    return result


def delete_field_definition(
    session: Session, definition_id: int, *, actor: str
) -> None:
    """删除字段定义：无历史值才可物理删除；有值只能停用（BAS-04-03）。"""
    definition = session.get(FieldDefinition, definition_id)
    if definition is None:
        raise NotFound(
            f"字段定义 {definition_id} 不存在", details={"field_definition_id": definition_id}
        )
    used = session.scalar(
        select(func.count())
        .select_from(EntityExtraValue)
        .where(EntityExtraValue.field_definition_id == definition_id)
    )
    if used:
        raise Conflict(
            f"字段 {definition.label} 已有 {used} 条历史值，只能停用不能删除",
            code=ErrorCode.FIELD_DEFINITION_HAS_VALUES,
            details={
                "field_key": definition.field_key,
                "value_count": int(used),
            },
        )
    record_audit(
        session,
        action=AuditAction.FIELD_DEFINITION_CHANGE,
        entity_type="field_definition",
        entity_id=f"{definition.entity_type}.{definition.field_key}",
        actor=actor,
        before={"label": definition.label, "is_active": definition.is_active},
        after={"deleted": True},
    )
    session.delete(definition)
    session.flush()




__all__ = [
    "create_field_definition",
    "delete_field_definition",
    "get_extra_values",
    "get_extra_values_bulk",
    "list_field_definitions",
    "set_extra_values",
    "set_field_definition_active",
    "update_field_definition",
]

