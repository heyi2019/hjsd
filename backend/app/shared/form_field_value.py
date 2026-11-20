"""扩展字段「单值校验」的唯一纯函数（FORM-01 / BAS-04）。

被两个域共用，二者只在三处**业务策略**上不同，其余 6 类字段校验完全同源：

============  ==========================  ================================
策略          严格域（``strict=True``）     宽松域（``strict=False``）
============  ==========================  ================================
调用方        ``form_values``             ``form_field_rules``
             客户/账号/线索/合作方实体      订单/资金/分期/库存操作表单
空选项        SELECT 无选项 → 拒绝         SELECT 无选项 → 放行（动态字段
                                          运行期由主数据填充，如付款方式）
None          直接透传                     按字段类型校验（None 非合法值）
未知类型      拒绝                         原样返回（历史类型静默保留）
============  ==========================  ================================

DATE 解析历史曾漂移：严格域 ``fromisoformat(strip 全串)``、宽松域
``fromisoformat(value[:10])``——同一份数据一处通过一处拒绝。本模块统一为
``normalize_date_value``：strip 后先试全串，失败再兼容带时间后缀的旧值截前
10 位，返回归一化的 ``YYYY-MM-DD``。前端 DatePicker 统一输出纯日期，故对
正常数据两域等价；该统一消除了脏数据口径不一致的 bug。

本模块只校验「一个 definition 对一个 value」，不查库、不处理必填。取哪些
字段定义、必填/条件必填由两域各自的编排函数负责。
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any, Protocol

from app.core.errors import Validation


class FieldDefinition(Protocol):
    """校验所需的最小字段定义接口（Orders/OrderFormField 的结构子集）。"""

    field_type: str
    label: str
    field_key: str
    options: list[Any] | None


def has_field_value(value: Any) -> bool:
    return value is not None and value != "" and value != []


def field_is_required(definition: Any, values: Mapping[str, Any]) -> bool:
    required = definition.required
    condition = definition.required_when
    if condition:
        dependency = values.get(condition.get("field"))
        if condition.get("op") == "filled":
            return has_field_value(dependency) and (not isinstance(dependency, str) or bool(dependency.strip()))
        current = dependency if isinstance(dependency, list) else [dependency]
        def condition_value(item: Any) -> str:
            if item is None:
                return ""
            if isinstance(item, bool):
                return "true" if item else "false"
            return str(item)
        hit = any(condition_value(item) in (condition.get("values") or []) for item in current)
        return not hit if condition.get("op") == "ne" else hit
    return required


def normalize_date_value(value: Any, definition: FieldDefinition) -> str:
    """校验并返回归一化的 ``YYYY-MM-DD``（两域共用的唯一 DATE 口径）。"""
    if not isinstance(value, str):
        raise Validation(
            f"字段 {definition.label} 必须为日期字符串",
            details={"field_key": definition.field_key},
        )
    text = value.strip()
    candidate = text
    try:
        date.fromisoformat(candidate)
    except ValueError:
        # 兼容历史脏数据：带时间后缀（T 或空格）时截前 10 位再校验。
        candidate = text[:10]
        try:
            date.fromisoformat(candidate)
        except ValueError as exc:
            raise Validation(
                f"字段 {definition.label} 必须为 YYYY-MM-DD 日期",
                details={"field_key": definition.field_key},
            ) from exc
    return candidate


def _option_values(definition: FieldDefinition, *, strict: bool) -> list[str]:
    """读取规范化选项值；严格域要求对象结构，宽松域兼容旧的非对象项。"""
    values: list[str] = []
    for item in definition.options or []:
        if not isinstance(item, Mapping):
            if strict:
                raise Validation("字段选项须为对象", details={"field": "options"})
            continue
        text = str(item.get("value") or "").strip()
        if not text:
            if strict:
                raise Validation("字段选项 value 不能为空", details={"field": "options"})
            continue
        values.append(text)
    return values


def validate_field_value(
    definition: FieldDefinition, value: Any, *, strict: bool
) -> Any:
    """按字段类型校验单值；``strict`` 固化严格/宽松域的三处策略差异。

    返回归一化后的值（严格域直接落库；宽松域调用方忽略返回值、保留原值）。
    """
    if value is None and strict:
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
    if kind == "TEXT":
        if not isinstance(value, str):
            raise Validation(
                f"字段 {definition.label} 必须为字符串",
                details={"field_key": definition.field_key},
            )
        return value
    if kind == "DATE":
        return normalize_date_value(value, definition)

    if kind in {"SELECT", "MULTI_SELECT"}:
        options = _option_values(definition, strict=strict)
        if kind == "SELECT":
            if not isinstance(value, str):
                raise Validation(
                    f"字段 {definition.label} 必须为字符串",
                    details={"field_key": definition.field_key},
                )
            if strict and not options:
                raise Validation(
                    f"字段 {definition.label} 未配置有效选项",
                    details={"field_key": definition.field_key},
                )
            if options and value not in options:
                raise Validation(
                    f"字段 {definition.label} 的取值必须在选项内",
                    details={"field_key": definition.field_key, "value": str(value)[:64]},
                )
            return value
        # MULTI_SELECT
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
        if strict and not options:
            raise Validation(
                f"字段 {definition.label} 未配置有效选项",
                details={"field_key": definition.field_key},
            )
        # 重复检查仅严格域执行；宽松域历史允许重复选项值（避免改变既有表单行为）。
        has_dup = strict and len(set(value)) != len(value)
        if has_dup or (options and any(item not in options for item in value)):
            raise Validation(
                f"字段 {definition.label} 的取值必须在选项内",
                details={"field_key": definition.field_key},
            )
        return value

    # 未知类型
    if strict:
        raise Validation(
            f"字段类型不支持：{kind}",
            details={"field": definition.field_key, "field_type": kind},
        )
    return value
