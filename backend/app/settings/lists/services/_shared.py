"""lists.services._shared：列配置与自定义列共用的读取、合并、快照原语。"""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

from sqlalchemy import case, cast, func, literal, select, true
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from app.domain.lists import ListColumnConfig, ListCustomColumn
from app.domain.parties import Customer
from app.domain.trade import Order, OrderFormField
from app.domain.form_scopes import FORM_SCOPES
from app.settings.lists.scopes import ListScope

CUSTOM_KEY_PREFIX = "extra:"
_DATA_EXTRA_SOURCES: tuple[tuple[type, str], ...] = ((Order, "订单"), (Customer, "客户"))
_DATA_KEY_RE = re.compile(r"^[A-Za-z0-9_]{1,60}$")
_SCOPE_LABELS: dict[str, str] = {scope.code: scope.label for scope in FORM_SCOPES}
# 审计 entity_type 沿用 list_column_config，让「设置 → 改动追溯」统一归到「列表字段」项。
_AUDIT_ENTITY_TYPE = "list_column_config"


def _rows_for_scope(session: Session, scope: str) -> dict[str, ListColumnConfig]:
    rows = session.scalars(
        select(ListColumnConfig).where(ListColumnConfig.scope == scope)
    ).all()
    return {row.column_key: row for row in rows}


def _custom_rows_for_scope(session: Session, scope: str) -> dict[str, ListCustomColumn]:
    rows = session.scalars(
        select(ListCustomColumn).where(ListCustomColumn.scope == scope)
    ).all()
    return {row.column_key: row for row in rows}


def _all_custom_rows(session: Session) -> dict[str, dict[str, ListCustomColumn]]:
    grouped: dict[str, dict[str, ListCustomColumn]] = {}
    for row in session.scalars(select(ListCustomColumn)).all():
        grouped.setdefault(row.scope, {})[row.column_key] = row
    return grouped


def _option_items(options: Any) -> list[dict[str, str]]:
    """归一化字段选项：兼容纯字符串数组与 {value,label} 对象数组。"""
    items: list[dict[str, str]] = []
    for item in options or []:
        if isinstance(item, str):
            if item.strip():
                items.append({"value": item.strip(), "label": item.strip()})
        elif isinstance(item, Mapping):
            value = str(item.get("value") or "").strip()
            if value:
                items.append({"value": value, "label": str(item.get("label") or value)})
    return items


def _value_labels(options: Any) -> dict[str, str] | None:
    items = _option_items(options)
    return {item["value"]: item["label"] for item in items} or None


def _current_field_option_labels(session: Session, customs: Iterable[ListCustomColumn]) -> dict[str, dict[str, str]]:
    keys = {column.source_key for column in customs if column.field_type in {"SELECT", "MULTI_SELECT"}}
    if not keys:
        return {}
    definitions = session.scalars(select(OrderFormField).where(
        OrderFormField.is_custom.is_(True), OrderFormField.is_active.is_(True), OrderFormField.field_key.in_(keys),
    ).order_by(OrderFormField.sort_order, OrderFormField.id)).all()
    labels: dict[str, dict[str, str]] = {}
    for definition in definitions:
        labels.setdefault(definition.field_key, _value_labels(definition.options) or {})
    return labels


def _merge(
    scope: ListScope,
    rows: dict[str, ListColumnConfig],
    customs: dict[str, ListCustomColumn],
    current_labels: dict[str, dict[str, str]] | None = None,
) -> dict[str, Any]:
    """把注册表列 + 自定义列定义与库内状态合并成对外结构。

    排序优先用库内 sort_order，未配置列以注册表下标×10 参与排序，
    保证「新加列」落在它代码里的自然位置；自定义列未配置时排在内置列之后。
    """
    items: list[dict[str, Any]] = []
    for index, column in enumerate(scope.columns):
        row = rows.get(column.key)
        items.append(
            {
                "key": column.key,
                "label": column.label,
                "locked": column.locked,
                "custom": False,
                "source_key": None,
                "value_labels": None,
                "is_visible": row.is_visible if row is not None else True,
                "sort_order": row.sort_order if row is not None else index * 10,
                "fixed": row.fixed if row is not None else None,
            }
        )
    # 自定义列默认排在内置列之后；已配置过则沿用配置顺序，可与内置列交错。
    base = len(scope.columns) * 10
    for position, (column_key, definition) in enumerate(
        sorted(customs.items(), key=lambda pair: pair[1].id)
    ):
        row = rows.get(column_key)
        items.append(
            {
                "key": column_key,
                "label": definition.label,
                "locked": False,
                "custom": True,
                "source_key": definition.source_key,
                "value_labels": {**(current_labels or {}).get(definition.source_key, {}), **(definition.value_labels or {})} or None,
                "is_visible": row.is_visible if row is not None else True,
                "sort_order": row.sort_order if row is not None else base + position * 10,
                "fixed": row.fixed if row is not None else None,
            }
        )
    items.sort(key=lambda item: item["sort_order"])
    # 稳定排序后把 sort_order 归一成 0,10,20…，避免历史空档越拖越大。
    for position, item in enumerate(items):
        item["sort_order"] = position * 10
    return {"code": scope.code, "label": scope.label, "columns": items}


def _config_snapshot(rows: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """列显示配置的审计前值快照（四字段口径）。"""
    return {
        key: {
            "is_visible": row.is_visible,
            "sort_order": row.sort_order,
            "fixed": row.fixed,
        }
        for key, row in rows.items()
    }


def _data_extra_keys(session: Session) -> dict[str, dict[str, Any]]:
    """汇总订单/客户 form_extra 中实际出现过的键：{key: {sources, row_count}}。

    这些键大多没有字段定义记录（历史流程直接写入），但值真实存在 ——
    作为「数据中已有值」候选，让管理员不展开详情也能把关心的字段提到列表里。
    """
    result: dict[str, dict[str, Any]] = {}
    for model, source_label in _DATA_EXTRA_SOURCES:
        payload = cast(model.form_extra, JSONB)
        object_payload = case(
            (func.jsonb_typeof(payload) == "object", payload),
            else_=cast(literal("{}"), JSONB),
        )
        entries = func.jsonb_each(object_payload).table_valued("key", "value").lateral()
        query = (
            select(entries.c.key, func.count())
            .select_from(model)
            .join(entries, true())
            .group_by(entries.c.key)
        )
        for key, count in session.execute(query):
            if not _DATA_KEY_RE.match(key):
                continue
            entry = result.setdefault(key, {"sources": [], "row_count": 0})
            entry["sources"].append(source_label)
            entry["row_count"] += count
    return result


def _has_data_extra_key(session: Session, key: str) -> bool:
    """只判断指定键是否存在，避免新增单列时重新汇总全部候选。"""
    for model, _ in _DATA_EXTRA_SOURCES:
        payload = cast(model.form_extra, JSONB)
        query = (
            select(literal(1))
            .select_from(model)
            .where(func.jsonb_typeof(payload) == "object", payload.has_key(key))
            .limit(1)
        )
        if session.scalar(query) is not None:
            return True
    return False
