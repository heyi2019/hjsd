"""订单选项名称快照：编码稳定，历史名称按写入时保留。"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.options import OptionSet
from app.domain.trade import OrderFormField
from app.shared.option_archive import OPTION_ITEM_ARCHIVE

_GROUPS = {
    "intermediary_platform": "INTERMEDIARY_PLATFORM",
    "intermediary_type": "INTERMEDIARY_TYPE",
    "compensation_type": "COMPENSATION_TYPE",
    "customer_source": "CUSTOMER_SOURCE",
    "dg_customer_source": "CUSTOMER_SOURCE",
    "supplier_source": "SUPPLIER_SOURCE",
}


def option_label_maps(session: Session, groups: set[str]) -> dict[tuple[str, str], str]:
    rows = session.scalars(select(OptionSet).where(OptionSet.code.in_(groups | {OPTION_ITEM_ARCHIVE}))).all()
    labels: dict[tuple[str, str], str] = {}
    for row in sorted(rows, key=lambda item: item.code != OPTION_ITEM_ARCHIVE):
        for item in row.options if isinstance(row.options, list) else []:
            if not isinstance(item, dict) or item.get("value") is None or item.get("label") is None:
                continue
            value = str(item.get("value", ""))
            if row.code == OPTION_ITEM_ARCHIVE:
                group, separator, value = value.rpartition(":")
                if not separator or group not in groups:
                    continue
            else:
                group = row.code
            labels[(group, value)] = str(item.get("label", ""))
    return labels


def update_option_label_snapshot(session: Session, previous: Mapping[str, Any] | None,
                                 old_values: Mapping[str, Any] | None,
                                 new_values: Mapping[str, Any] | None,
                                 *, scopes: tuple[str, ...] = ()) -> dict[str, Any]:
    old, new = dict(old_values or {}), dict(new_values or {})
    result = dict(previous or {})
    changed = [(field, group) for key, group in _GROUPS.items() for field in (key, f"sell_{key}")
               if field in new and (field not in result or old.get(field) != new.get(field))]
    if changed:
        groups = {group for _, group in changed}
        labels = option_label_maps(session, groups)
        for field, group in changed:
            value = new.get(field)
            label = labels.get((group, value)) if isinstance(value, str) else None
            if label:
                result[field] = label
            else:
                result.pop(field, None)
    keys = {key for key in new if key not in _GROUPS and (key not in result or old.get(key) != new.get(key))}
    if not scopes or not keys:
        return result
    definitions = session.scalars(select(OrderFormField).where(
        OrderFormField.order_type_code.in_(scopes), OrderFormField.field_key.in_(keys),
        OrderFormField.is_custom.is_(True), OrderFormField.field_type.in_(("SELECT", "MULTI_SELECT")),
    )).all()
    definitions = sorted(definitions, key=lambda item: scopes.index(item.order_type_code))
    seen: set[str] = set()
    for definition in definitions:
        key = definition.field_key
        if key in seen:
            continue
        seen.add(key)
        labels = {item["value"]: item["label"] for item in definition.options or []
                  if isinstance(item, dict) and isinstance(item.get("value"), str) and isinstance(item.get("label"), str)}
        value = new[key]
        if isinstance(value, list):
            previous_labels = result.get(key) if isinstance(result.get(key), dict) else {}
            old_items = old.get(key) if isinstance(old.get(key), list) else []
            selected = {item: previous_labels.get(item, labels.get(item)) if item in old_items else labels.get(item)
                        for item in value if isinstance(item, str)}
            result[key] = {code: label for code, label in selected.items() if isinstance(label, str)}
        elif isinstance(value, str) and value in labels:
            result[key] = labels[value]
        else:
            result.pop(key, None)
    return result
