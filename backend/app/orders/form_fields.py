"""orders.form_fields：建单表单字段配置的 CRUD 与护栏。

本模块是**全站唯一的表单字段配置来源**：描述「建单表单」与「客户建档」等表单的字段构成
（显示/必填/停用/排序/增删），不存储实体附加属性值。自定义字段（is_custom=1）即扩展字段，
其值落在实体行内的 form_extra（订单 Order.form_extra、客户 Customer.form_extra）。
核心核算字段 locked=True，仅禁止物理删除；required 与 is_active 仍可按业务需要配置
（停用核心字段由前端提示风险）。
"""
from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.domain.enums import AuditAction
from app.domain.trade import OrderFormField

FIELD_TYPES = ("TEXT", "NUMBER", "DATE", "BOOLEAN", "SELECT", "MULTI_SELECT")
REQUIRED_WHEN_OPS = ("eq", "ne", "filled")
FIELD_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
ORDER_TYPE_CODE_PATTERN = re.compile(r"^[A-Z0-9]{2,10}$")

_UNSET: Any = object()


def _normalize_required_when(
    session: Session,
    *,
    order_type_code: str,
    field_key: str,
    required_when: Any,
) -> dict[str, Any] | None:
    """归一化「条件必填」条件：校验依赖字段存在、运算符合法、触发值匹配运算符。

    条件与 required 互斥，由调用方在 required=True 时不写入本字段。
    """
    if required_when is None:
        return None
    if not isinstance(required_when, Mapping):
        raise Validation("required_when 必须为对象", details={"field": "required_when"})
    dep = str(required_when.get("field") or "").strip()
    if not dep:
        raise Validation(
            "条件必填需指定依赖字段", details={"field": "required_when.field"}
        )
    if dep == field_key:
        raise Validation(
            "条件必填的依赖字段不能是自身", details={"field": "required_when.field", "value": dep}
        )
    op = str(required_when.get("op") or "eq").strip()
    if op not in REQUIRED_WHEN_OPS:
        raise Validation(
            f"条件运算符必须为 {REQUIRED_WHEN_OPS}",
            details={"field": "required_when.op", "value": op},
        )
    raw_values = required_when.get("values")
    if isinstance(raw_values, (str, bytes)):
        raise Validation("触发值必须为数组", details={"field": "required_when.values"})
    values = [str(v).strip() for v in (raw_values or []) if str(v).strip()]
    if op in ("eq", "ne") and not values:
        raise Validation(
            "等于/不等于条件需至少一个触发值", details={"field": "required_when.values"}
        )
    if op == "filled" and values:
        raise Validation(
            "「有值」条件不接受触发值", details={"field": "required_when.values"}
        )
    dep_row = session.scalar(
        select(OrderFormField).where(
            OrderFormField.order_type_code == order_type_code,
            OrderFormField.field_key == dep,
        )
    )
    if dep_row is None:
        raise Validation(
            "条件必填的依赖字段不存在于当前表单",
            details={"field": "required_when.field", "value": dep},
        )
    return {"field": dep, "op": op, "values": values or None}



def _normalize_field_options(
    field_type: str,
    options: Sequence[Any] | None,
) -> list[dict[str, str]]:
    """归一化为 [{value,label}] 对象数组；兼容纯字符串数组（value=label）。"""
    if options is None:
        raw: list[Any] = []
    elif isinstance(options, (str, bytes)):
        raise Validation("字段选项必须为数组", details={"field": "options"})
    else:
        raw = list(options)
    if field_type not in ("SELECT", "MULTI_SELECT"):
        if raw:
            raise Validation("非选择型字段不能配置选项", details={"field": "options"})
        return []
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    for option in raw:
        if isinstance(option, str):
            item = {"value": option.strip(), "label": option.strip()}
        elif isinstance(option, Mapping) and "value" in option:
            v = str(option.get("value", "")).strip()
            l = str(option.get("label", v)).strip() or v
            if not v:
                raise Validation("字段选项 value 不能为空", details={"field": "options"})
            item = {"value": v, "label": l}
        elif hasattr(option, "value") and not isinstance(option, (int, float, bool)):
            # 兼容 Pydantic FieldOption 等对象（路由层直接透传时）
            v = str(getattr(option, "value", "") or "").strip()
            l = str(getattr(option, "label", "") or v).strip() or v
            if not v:
                raise Validation("字段选项 value 不能为空", details={"field": "options"})
            item = {"value": v, "label": l}
        else:
            raise Validation("字段选项须为字符串或 {value,label}", details={"field": "options"})
        if not item["value"]:
            raise Validation("字段选项不能为空", details={"field": "options"})
        if item["value"] in seen:
            raise Validation("字段选项不能重复", details={"field": "options"})
        seen.add(item["value"])
        normalized.append(item)
    if not normalized:
        raise Validation("选择型字段至少需要一个选项", details={"field": "options"})
    return normalized


def create_order_form_field(
    session: Session,
    *,
    order_type_code: str,
    field_key: str,
    label: str,
    actor: str,
    field_type: str = "TEXT",
    options: Sequence[str] | None = None,
    required: bool = False,
    required_when: Any = None,
    is_active: bool = True,
    sort_order: int = 0,
    note: str | None = None,
) -> OrderFormField:
    """新增自定义表单字段；核心字段由种子锁定，不在 UI 暴露新增入口。"""
    code = (order_type_code or "").strip().upper()
    if not ORDER_TYPE_CODE_PATTERN.match(code):
        raise Validation(
            "业务类型 code 必须为 2-10 位大写字母或数字",
            details={"field": "order_type_code", "value": order_type_code},
        )
    if not isinstance(field_type, str) or field_type not in FIELD_TYPES:
        raise Validation(
            f"字段类型必须为 {FIELD_TYPES}", details={"field": "field_type", "value": field_type}
        )
    if isinstance(sort_order, bool) or not isinstance(sort_order, int) or sort_order < 0:
        raise Validation("排序值必须为非负整数", details={"field": "sort_order"})
    key = (field_key or "").strip()
    if not FIELD_KEY_PATTERN.match(key):
        raise Validation(
            "字段键必须为小写字母开头，仅含小写字母、数字与下划线",
            details={"field": "field_key", "value": field_key},
        )
    if not isinstance(label, str) or not label.strip():
        raise Validation("字段名称不能为空", details={"field": "label"})
    normalized_options = _normalize_field_options(field_type, options)
    exists = session.scalar(
        select(OrderFormField).where(
            OrderFormField.order_type_code == code, OrderFormField.field_key == key
        )
    )
    if exists is not None:
        raise Conflict(
            f"字段 {key} 已存在",
            code=ErrorCode.DUPLICATE_CODE,
            details={"order_type_code": code, "field_key": key},
        )
    if not isinstance(required, bool):
        raise Validation("required 必须为布尔值", details={"field": "required"})
    # 必填与条件必填互斥：required=True 时忽略条件配置。
    normalized_condition = (
        None
        if required
        else _normalize_required_when(
            session, order_type_code=code, field_key=key, required_when=required_when
        )
    )
    definition = OrderFormField(
        order_type_code=code,
        field_key=key,
        label=label.strip(),
        field_type=field_type,
        options=normalized_options or None,
        required=required,
        required_when=normalized_condition,
        is_active=is_active,
        sort_order=sort_order,
        locked=False,
        is_custom=True,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(definition)
    session.flush()
    record_audit(
        session,
        action=AuditAction.ORDER_FORM_FIELD_CHANGE,
        entity_type="order_form_field",
        entity_id=f"{code}.{key}",
        actor=actor,
        after={
            "label": definition.label,
            "is_active": definition.is_active,
            "required_when": definition.required_when,
        },
    )
    return definition


def update_order_form_field(
    session: Session,
    definition_id: int,
    *,
    actor: str,
    label: str | None = None,
    field_type: str | None = None,
    options: Sequence[str] | None | object = None,
    required: bool | None = None,
    required_when: Any = _UNSET,
    sort_order: int | None = None,
    note: str | None = None,
) -> OrderFormField:
    """编辑字段：label/类型/选项/必填态/排序/备注可改；field_key 与 code 固定。"""
    definition = session.get(OrderFormField, definition_id)
    if definition is None:
        raise NotFound(
            f"表单字段 {definition_id} 不存在", details={"order_form_field_id": definition_id}
        )
    if label is not None:
        if not isinstance(label, str) or not label.strip():
            raise Validation("字段名称不能为空", details={"field": "label"})
        next_label = label.strip()
    else:
        next_label = definition.label
    next_type = definition.field_type if field_type is None else field_type
    if field_type is not None and (
        not isinstance(field_type, str) or field_type not in FIELD_TYPES
    ):
        raise Validation(
            f"字段类型必须为 {FIELD_TYPES}", details={"field": "field_type", "value": field_type}
        )
    next_options = (
        _normalize_field_options(next_type, options)
        if options is not None
        else list(definition.options or [])
    )
    before = {
        "label": definition.label,
        "field_type": definition.field_type,
        "options": definition.options,
        "required": definition.required,
        "required_when": definition.required_when,
        "sort_order": definition.sort_order,
        "note": definition.note,
    }
    definition.label = next_label
    definition.field_type = next_type
    definition.options = next_options or None
    if required is not None:
        if not isinstance(required, bool):
            raise Validation("required 必须为布尔值", details={"field": "required"})
        definition.required = required
        if required:
            # 必填与条件必填互斥：设为必填即清除条件。
            definition.required_when = None
    if required_when is not _UNSET:
        if required_when is not None and definition.required:
            raise Validation(
                "字段已设为必填，不能再配置条件必填（请先设为选填）",
                details={"field": "required_when"},
            )
        definition.required_when = (
            None
            if required_when is None
            else _normalize_required_when(
                session,
                order_type_code=definition.order_type_code,
                field_key=definition.field_key,
                required_when=required_when,
            )
        )
    if sort_order is not None:
        if isinstance(sort_order, bool) or not isinstance(sort_order, int) or sort_order < 0:
            raise Validation("排序值必须为非负整数", details={"field": "sort_order"})
        definition.sort_order = sort_order
    definition.note = note
    definition.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.ORDER_FORM_FIELD_CHANGE,
        entity_type="order_form_field",
        entity_id=f"{definition.order_type_code}.{definition.field_key}",
        actor=actor,
        before=before,
        after={
            "label": definition.label,
            "field_type": definition.field_type,
            "options": definition.options,
            "required": definition.required,
            "required_when": definition.required_when,
            "sort_order": definition.sort_order,
            "note": definition.note,
        },
    )
    return definition


def list_order_form_fields(
    session: Session, *, order_type_code: str, include_inactive: bool = True
) -> list[OrderFormField]:
    stmt = select(OrderFormField).where(
        OrderFormField.order_type_code == order_type_code.strip().upper()
    )
    if not include_inactive:
        stmt = stmt.where(OrderFormField.is_active.is_(True))
    return list(session.scalars(stmt.order_by(OrderFormField.sort_order, OrderFormField.id)))


def set_order_form_field_active(
    session: Session, definition_id: int, active: bool, *, actor: str
) -> OrderFormField:
    """停用/启用字段：核心字段(locked)也允许切换 is_active，由前端提示风险。"""
    if not isinstance(active, bool):
        raise Validation("active 必须为布尔值", details={"field": "active"})
    definition = session.get(OrderFormField, definition_id)
    if definition is None:
        raise NotFound(
            f"表单字段 {definition_id} 不存在", details={"order_form_field_id": definition_id}
        )
    before = definition.is_active
    definition.is_active = active
    definition.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.ORDER_FORM_FIELD_CHANGE,
        entity_type="order_form_field",
        entity_id=f"{definition.order_type_code}.{definition.field_key}",
        actor=actor,
        before={"is_active": before},
        after={"is_active": active},
    )
    return definition


def delete_order_form_field(session: Session, definition_id: int, *, actor: str) -> None:
    """删除字段：locked 核心字段禁止删除；自定义字段可删（历史值留存在 Order.form_extra）。"""
    definition = session.get(OrderFormField, definition_id)
    if definition is None:
        raise NotFound(
            f"表单字段 {definition_id} 不存在", details={"order_form_field_id": definition_id}
        )
    if definition.locked:
        raise Validation(
            f"核心字段 {definition.label} 已锁定，不可删除（仅可改必填/停用）",
            details={"field_key": definition.field_key},
        )
    record_audit(
        session,
        action=AuditAction.ORDER_FORM_FIELD_CHANGE,
        entity_type="order_form_field",
        entity_id=f"{definition.order_type_code}.{definition.field_key}",
        actor=actor,
        before={"label": definition.label, "is_active": definition.is_active},
        after={"deleted": True},
    )
    session.delete(definition)
    session.flush()


__all__ = [
    "create_order_form_field",
    "delete_order_form_field",
    "list_order_form_fields",
    "set_order_form_field_active",
    "update_order_form_field",
]
