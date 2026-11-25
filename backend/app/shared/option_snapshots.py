"""订单选项名称快照：编码稳定，历史名称按写入时保留。"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.options import OptionSet
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


def update_option_label_snapshot(session: Session, previous: Mapping[str, str] | None,
                                 old_values: Mapping[str, Any] | None,
                                 new_values: Mapping[str, Any] | None) -> dict[str, str]:
    old, new = dict(old_values or {}), dict(new_values or {})
    result = dict(previous or {})
    changed = [(field, group) for key, group in _GROUPS.items() for field in (key, f"sell_{key}")
               if field in new and (field not in result or old.get(field) != new.get(field))]
    if not changed:
        return result
    groups = {group for _, group in changed}
    labels = option_label_maps(session, groups)
    for field, group in changed:
        value = new.get(field)
        label = labels.get((group, value)) if isinstance(value, str) else None
        if label:
            result[field] = label
        else:
            result.pop(field, None)
    return result
