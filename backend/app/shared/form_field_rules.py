"""orders.form_field_rules：表单字段的枚举常量、键格式校验与 form_extra 规则校验。"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import re
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.domain.trade import OrderFormField
from app.domain.users import User
from app.domain.form_scopes import SCOPE_CODES
from app.shared.form_field_value import field_is_required, has_field_value, validate_field_value

FIELD_TYPES = ("TEXT", "NUMBER", "DATE", "BOOLEAN", "SELECT", "MULTI_SELECT")


FIELD_SECTIONS = (
    "EXTRA",
    "ACCOUNT_PRODUCT",
    "PARTICIPANT",
    "FINANCE",
    "BUSINESS",
    "DELIVER",
    "OPERATION",
)


REQUIRED_WHEN_OPS = ("eq", "ne", "filled")


FIELD_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")


ORDER_TYPE_CODE_PATTERN = re.compile(r"^[A-Z0-9]{2,16}$")

BUSINESS_RESPONSIBLE_FIELD_KEY = "business_responsible_ids"
BUSINESS_RESPONSIBLE_ORDER_TYPES = {"HS", "TH", "DG"}


SECTION_KEY_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{0,31}$")


_UNSET: Any = object()


def normalize_form_scope(value: str) -> str:
    """把表单作用域归一化为注册表中的唯一编码。

    表单值是跨订单、库存、分期和资金的共享契约；未知编码必须立即失败，
    否则字段值会被静默存储或丢弃，导致前后端表单看似成功但无法回显。
    """
    code = str(value or "").strip().upper()
    if code not in SCOPE_CODES:
        raise Validation("表单作用域不存在", details={"field": "form_extra_scope", "value": value})
    return code


def _validate_section(section: str) -> None:
    if not isinstance(section, str) or not SECTION_KEY_PATTERN.fullmatch(section.strip()):
        raise Validation("字段归属板块键不合法", details={"field": "section", "value": section})


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
            OrderFormField.is_active.is_(True),
        )
    )
    if dep_row is None:
        # 依赖字段既不能不存在，也不能已停用：停用的字段不会被前端渲染，
        # 条件必填会静默失效。历史数据允许保留，但不得再新增悬空依赖。
        raise Validation(
            "条件必填的依赖字段不存在或已停用",
            details={"field": "required_when.field", "value": dep},
        )
    return {"field": dep, "op": op, "values": values or None}


def _normalize_field_options(
    field_type: str,
    options: Sequence[Any] | None,
) -> list[dict[str, str]]:
    """归一化为 [{value,label}] 对象数组。"""
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
        if isinstance(option, Mapping) and "value" in option:
            v = str(option.get("value", "")).strip()
            l = str(option.get("label", v)).strip() or v
            if not v:
                raise Validation("字段选项 value 不能为空", details={"field": "options"})
            item = {"value": v, "label": l}
        else:
            raise Validation("字段选项须为对象", details={"field": "options"})
        if not item["value"]:
            raise Validation("字段选项不能为空", details={"field": "options"})
        if item["value"] in seen:
            raise Validation("字段选项不能重复", details={"field": "options"})
        seen.add(item["value"])
        normalized.append(item)
    if not normalized:
        raise Validation("选择型字段至少需要一个选项", details={"field": "options"})
    return normalized


def validate_form_extra(
    session: Session,
    *,
    order_type_code: str,
    values: Mapping[str, Any] | None,
    context: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """校验任意设置→表单字段作用域的扩展值。

    表单字段配置虽然历史上以 ``order_type_code`` 命名，但现在覆盖订单、
    库存操作、分期、资金、客户等全部作用域。值仍采用同一 JSON 约定；
    已删除/停用字段的历史键允许继续保留，以保证历史单据可读。
    """
    scope = normalize_form_scope(order_type_code)
    normalized = dict(values or {})
    condition_values = {**normalized, **(context or {})}
    active_custom = list(session.scalars(
        select(OrderFormField).where(
            OrderFormField.order_type_code == scope,
            OrderFormField.is_custom.is_(True),
            OrderFormField.is_active.is_(True),
        )
    ))
    definitions = {field.field_key: field for field in active_custom}
    for field_key, value in normalized.items():
        definition = definitions.get(field_key)
        if definition is None:
            # 已删除/停用字段的历史键允许保留（宽松域契约）。
            continue
        # 宽松口径：空选项放行（运行期动态字段）、未知类型原样返回，校验结果
        # 不写回——本域保留提交原值。三处策略差异由 strict=False 固化。
        validate_field_value(definition, value, strict=False)

    for definition in active_custom:
        if field_is_required(definition, condition_values) and not has_field_value(normalized.get(definition.field_key)):
            raise Validation(f"字段 {definition.label} 必填", details={"field_key": definition.field_key})
    return normalized


def validate_business_responsible(
    session: Session,
    *,
    order_type_code: str,
    values: Mapping[str, Any] | None,
) -> None:
    """校验三类账号订单的业务负责人核心字段。"""
    if order_type_code not in BUSINESS_RESPONSIBLE_ORDER_TYPES:
        return
    definition = session.scalar(
        select(OrderFormField).where(
            OrderFormField.order_type_code == order_type_code,
            OrderFormField.field_key == BUSINESS_RESPONSIBLE_FIELD_KEY,
            OrderFormField.is_active.is_(True),
        )
    )
    raw = (values or {}).get(BUSINESS_RESPONSIBLE_FIELD_KEY)
    label = definition.label if definition is not None else "业务操作人"
    if raw in (None, []) and (definition is None or not definition.required):
        return
    if not isinstance(raw, list) or not raw or any(
        isinstance(item, bool) or not isinstance(item, int) or item <= 0 for item in raw
    ):
        raise Validation(
            f"字段 {label} 必填",
            details={"field_key": BUSINESS_RESPONSIBLE_FIELD_KEY},
        )
    if len(set(raw)) != len(raw):
        raise Validation(
            f"字段 {label} 不能重复选择",
            details={"field_key": BUSINESS_RESPONSIBLE_FIELD_KEY},
        )
    active_ids = set(session.scalars(select(User.id).where(User.id.in_(raw), User.is_active.is_(True))))
    if active_ids != set(raw):
        raise Validation(
            f"字段 {label} 必须选择在职员工",
            details={"field_key": BUSINESS_RESPONSIBLE_FIELD_KEY},
        )
