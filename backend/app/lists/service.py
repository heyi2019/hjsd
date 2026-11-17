"""lists.service：列表列配置的读取与保存 + 自定义列定义。

口径：
- 列清单与中文名以注册表为准，库只存 is_visible / sort_order / fixed；
- 缺行的列（新增列）默认可见，按注册表位置插入，不需要数据迁移；
- 锁定列（身份列/操作列）不允许隐藏，后端二次校验，不能只靠前端置灰；
- fixed 只存「覆盖值」，None 表示不固定；
- 保存整表覆盖该 scope，并写审计（前后值都记，便于追溯谁把哪列关了）。

自定义列（ListCustomColumn）：
- 定义（列名 + 数据来源字段键 + 选项中文快照）单独存表，显示状态仍复用 ListColumnConfig；
- 列键统一 `extra:{field_key}`，与注册表内置列命名空间隔离；
- 恢复默认只清显示配置行，**不删自定义列定义**（新增的列是配置资产，删除需显式操作）；
- 值从行数据 `form_extra` / `extra_values` 按 source_key 取，见前端 listColumns.ts。
"""
from __future__ import annotations

import re
from collections.abc import Collection, Mapping
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.domain.enums import AuditAction
from app.domain.lists import ListColumnConfig, ListCustomColumn
from app.domain.options import OptionSet
from app.domain.parties import Customer
from app.domain.trade import Order, OrderFormField
from app.lists.scopes import LIST_SCOPES, ListScope, get_scope
from app.domain.form_scopes import FORM_SCOPES

CUSTOM_KEY_PREFIX = "extra:"

# 「数据中已有值」候选的扫描源：行数据 form_extra 里实际出现过的键。
_DATA_EXTRA_SOURCES: tuple[tuple[type, str], ...] = ((Order, "订单"), (Customer, "客户"))
# 数据键兜底校验：只放行常见字段键字符，防止把任意字符串存成列定义。
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


def _merge(
    scope: ListScope,
    rows: dict[str, ListColumnConfig],
    customs: dict[str, ListCustomColumn],
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
                "value_labels": definition.value_labels or None,
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


def list_configs(session: Session) -> list[dict[str, Any]]:
    """列出全部列表作用域及其列配置（设置页与各列表页共用）。"""
    grouped = _all_custom_rows(session)
    return [
        _merge(scope, _rows_for_scope(session, scope.code), grouped.get(scope.code, {}))
        for scope in LIST_SCOPES
    ]


def get_config(session: Session, scope_code: str) -> dict[str, Any]:
    scope = get_scope(scope_code)
    if scope is None:
        raise NotFound(f"列表 {scope_code} 不存在", details={"scope": scope_code})
    return _merge(
        scope,
        _rows_for_scope(session, scope_code),
        _custom_rows_for_scope(session, scope_code),
    )


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


def reset_config(session: Session, scope_code: str, *, actor: str) -> dict[str, Any]:
    """恢复默认：清空该列表的全部**显示配置行**，回到注册表 + 自定义列定义的默认顺序。

    自定义列定义不删 —— 那是管理员新增的资产，删除需走 DELETE /custom/{key}。
    默认值本来就由注册表与定义表决定，删配置行即回到默认，不需要另存一份「默认配置」。
    """
    scope = get_scope(scope_code)
    if scope is None:
        raise NotFound(f"列表 {scope_code} 不存在", details={"scope": scope_code})

    rows = _rows_for_scope(session, scope_code)
    customs = _custom_rows_for_scope(session, scope_code)
    if rows:
        before = _config_snapshot(rows)
        for row in rows.values():
            session.delete(row)
        session.flush()
        record_audit(
            session,
            action=AuditAction.LIST_COLUMNS_RESET,
            entity_type=_AUDIT_ENTITY_TYPE,
            entity_id=scope_code,
            actor=actor,
            before={"scope": scope_code, "columns": before},
            after={"scope": scope_code, "columns": {}},
        )
    return _merge(scope, {}, customs)


def save_config(
    session: Session,
    scope_code: str,
    items: list[dict[str, Any]],
    *,
    actor: str,
) -> dict[str, Any]:
    """整表覆盖某列表的列配置：可见性 + 顺序，一次事务一条审计。"""
    scope = get_scope(scope_code)
    if scope is None:
        raise NotFound(f"列表 {scope_code} 不存在", details={"scope": scope_code})

    known = {column.key: column for column in scope.columns}
    custom_keys = set(_custom_rows_for_scope(session, scope_code))
    seen: set[str] = set()
    for item in items:
        key = item["column_key"]
        if key not in known and key not in custom_keys:
            raise Validation(
                "列不属于该列表",
                details={
                    "scope": scope_code,
                    "column_key": key,
                    "allowed": [*known, *sorted(custom_keys)],
                },
            )
        if key in seen:
            raise Validation("列重复提交", details={"column_key": key})
        seen.add(key)

    rows = _rows_for_scope(session, scope_code)
    before = _config_snapshot(rows)
    changed = False
    for index, item in enumerate(items):
        key = item["column_key"]
        sort_order = index * 10
        row = rows.get(key)
        if row is None:
            session.add(
                ListColumnConfig(
                    scope=scope_code,
                    column_key=key,
                    is_visible=item["is_visible"],
                    sort_order=sort_order,
                    fixed=item.get("fixed"),
                    created_by=actor,
                    updated_by=actor,
                )
            )
            changed = True
            continue
        if (
            row.is_visible != item["is_visible"]
            or row.sort_order != sort_order
            or row.fixed != item.get("fixed")
        ):
            row.is_visible = item["is_visible"]
            row.sort_order = sort_order
            row.fixed = item.get("fixed")
            row.updated_by = actor
            changed = True

    if changed:
        session.flush()
        after = {
            item["column_key"]: {
                "is_visible": item["is_visible"],
                "sort_order": index * 10,
                "fixed": item.get("fixed"),
            }
            for index, item in enumerate(items)
        }
        record_audit(
            session,
            action=AuditAction.LIST_COLUMNS_UPDATE,
            entity_type=_AUDIT_ENTITY_TYPE,
            entity_id=scope_code,
            actor=actor,
            before={"scope": scope_code, "columns": before},
            after={"scope": scope_code, "columns": after},
        )
    return _merge(scope, _rows_for_scope(session, scope_code), _custom_rows_for_scope(session, scope_code))


def option_labels_by_code(
    session: Session, codes: Collection[str]
) -> dict[str, dict[str, str]]:
    """按字典 code 批量取 {code: {代码值: 中文}}。

    事实源是 `option_sets` 表；字典行缺失或选项为空时该组为空，导出保留原值，
    不因字典缺失而失败。主列表列值翻译与订单台账明细 sheet 共用这一入口。
    """
    labels: dict[str, dict[str, str]] = {}
    for row in session.scalars(select(OptionSet).where(OptionSet.code.in_(codes))).all():
        options = row.options if isinstance(row.options, list) else []
        labels[row.code] = {
            str(item["value"]): str(item["label"])
            for item in options
            if isinstance(item, dict)
            and item.get("value") is not None
            and item.get("label") is not None
        }
    return labels


def get_value_labels(session: Session, scope_code: str) -> dict[str, dict[str, str]]:
    """列值中文映射：{列 key: {代码值: 中文}}，供报表导出把枚举码翻成中文。

    事实源是 `option_sets` 表（D 类字典，可编辑项由管理员维护）；列注册表只用
    `ListColumn.value_set` 声明「这列属于哪组字典」，不复制第二份文案。
    自定义列的映射来自其字段选项快照（ListCustomColumn.value_labels）。
    字典行缺失或选项为空时该列不做翻译 —— 导出保留原值，不因字典缺失而失败。
    """
    scope = get_scope(scope_code)
    if scope is None:
        return {}
    codes = {column.value_set for column in scope.columns if column.value_set}
    by_code = option_labels_by_code(session, codes) if codes else {}
    result = {
        column.key: by_code[column.value_set]
        for column in scope.columns
        if column.value_set and by_code.get(column.value_set)
    }
    for column_key, definition in _custom_rows_for_scope(session, scope_code).items():
        if definition.value_labels:
            result[column_key] = dict(definition.value_labels)
    return result


def _data_extra_keys(session: Session) -> dict[str, dict[str, Any]]:
    """扫描订单/客户行数据 form_extra 中实际出现过的键：{key: {sources, row_count}}。

    这些键大多没有字段定义记录（历史流程直接写入），但值真实存在 ——
    作为「数据中已有值」候选，让管理员不展开详情也能把关心的字段提到列表里。
    """
    result: dict[str, dict[str, Any]] = {}
    for model, source_label in _DATA_EXTRA_SOURCES:
        for (payload,) in session.execute(select(model.form_extra)).all():
            if not isinstance(payload, dict):
                continue
            for key in payload:
                if not isinstance(key, str) or not _DATA_KEY_RE.match(key):
                    continue
                entry = result.setdefault(key, {"sources": [], "row_count": 0})
                if source_label not in entry["sources"]:
                    entry["sources"].append(source_label)
                entry["row_count"] += 1
    return result


def list_custom_field_options(session: Session) -> list[dict[str, Any]]:
    """可作为自定义列来源的字段，按来源分组排序。

    两类候选：
    1. 全部启用的表单自定义字段（is_custom=1 & is_active=1）——带选项快照，值可翻中文；
    2. 「数据中已有值」的键（订单/客户 form_extra 实际出现、且未在上面出现）——
       多为历史流程写入、无字段定义，按原值展示，标注来源与行数。

    不按「列表 ↔ 表单」做硬映射：订单/账号实体的 form_extra 会合并多个表单作用域的
    字段值（如 ALLOCATION 也写进订单），硬映射反而会漏。由管理员按来源标签自己挑。
    """
    rows = session.scalars(
        select(OrderFormField)
        .where(
            OrderFormField.is_custom.is_(True),
            OrderFormField.is_active.is_(True),
        )
        .order_by(OrderFormField.order_type_code, OrderFormField.sort_order, OrderFormField.id)
    ).all()
    options = [
        {
            "scope": row.order_type_code,
            "scope_label": _SCOPE_LABELS.get(row.order_type_code, row.order_type_code),
            "field_key": row.field_key,
            "label": row.label,
            "field_type": row.field_type,
            "options": _option_items(row.options),
        }
        for row in rows
    ]
    known_keys = {item["field_key"] for item in options}
    # 兜底中文名：任意字段定义（含停用/非自定义）里同 key 的 label，没有就用键名本身。
    label_by_key = {
        row.field_key: row.label
        for row in session.scalars(select(OrderFormField)).all()
        if row.label
    }
    for key, info in sorted(_data_extra_keys(session).items()):
        if key in known_keys:
            continue
        known_keys.add(key)
        options.append(
            {
                "scope": "DATA",
                "scope_label": "数据中已有值",
                "field_key": key,
                "label": label_by_key.get(key) or key,
                "field_type": "TEXT",
                "options": [],
                "data_only": True,
                "source_label": " / ".join(info["sources"]),
                "row_count": info["row_count"],
            }
        )
    return options


def add_custom_column(
    session: Session,
    scope_code: str,
    *,
    field_key: str,
    label: str | None,
    actor: str,
) -> dict[str, Any]:
    """为某列表新增一列，绑定已启用的表单自定义字段或数据中已有值的字段。"""
    scope = get_scope(scope_code)
    if scope is None:
        raise NotFound(f"列表 {scope_code} 不存在", details={"scope": scope_code})
    key = (field_key or "").strip()
    definition = session.scalar(
        select(OrderFormField)
        .where(
            OrderFormField.is_custom.is_(True),
            OrderFormField.is_active.is_(True),
            OrderFormField.field_key == key,
        )
        .order_by(OrderFormField.sort_order, OrderFormField.id)
    )
    field_type = "TEXT"
    value_labels = None
    if definition is not None:
        field_type = definition.field_type
        value_labels = _value_labels(definition.options)
    elif not _DATA_KEY_RE.match(key) or key not in _data_extra_keys(session):
        raise Validation(
            "字段不是已启用的自定义字段，数据中也没有该字段的值",
            details={"field_key": key},
        )
    column_key = f"{CUSTOM_KEY_PREFIX}{key}"
    if len(column_key) > 80:
        raise Validation("字段键过长，无法作为列名", details={"field_key": key})
    if session.scalar(
        select(ListCustomColumn).where(
            ListCustomColumn.scope == scope_code,
            ListCustomColumn.column_key == column_key,
        )
    ) is not None:
        raise Conflict(
            "该列表已存在此自定义列",
            code=ErrorCode.DUPLICATE_CODE,
            details={"scope": scope_code, "column_key": column_key},
        )
    final_label = (label or (definition.label if definition else None) or key).strip()[:64] or key[:64]
    session.add(
        ListCustomColumn(
            scope=scope_code,
            column_key=column_key,
            label=final_label,
            source_key=key,
            field_type=field_type,
            value_labels=value_labels,
            created_by=actor,
            updated_by=actor,
        )
    )
    session.flush()
    record_audit(
        session,
        action=AuditAction.LIST_COLUMN_ADD,
        entity_type=_AUDIT_ENTITY_TYPE,
        entity_id=f"{scope_code}.{column_key}",
        actor=actor,
        before=None,
        after={
            "scope": scope_code,
            "column_key": column_key,
            "label": final_label,
            "source_key": key,
        },
    )
    return get_config(session, scope_code)


def remove_custom_column(
    session: Session,
    scope_code: str,
    column_key: str,
    *,
    actor: str,
) -> dict[str, Any]:
    """删除自定义列定义，并连带清掉它的显示配置行。"""
    scope = get_scope(scope_code)
    if scope is None:
        raise NotFound(f"列表 {scope_code} 不存在", details={"scope": scope_code})
    definition = session.scalar(
        select(ListCustomColumn).where(
            ListCustomColumn.scope == scope_code,
            ListCustomColumn.column_key == column_key,
        )
    )
    if definition is None:
        raise NotFound(
            "自定义列不存在", details={"scope": scope_code, "column_key": column_key}
        )
    before = {
        "scope": scope_code,
        "column_key": column_key,
        "label": definition.label,
        "source_key": definition.source_key,
    }
    config_row = session.scalar(
        select(ListColumnConfig).where(
            ListColumnConfig.scope == scope_code,
            ListColumnConfig.column_key == column_key,
        )
    )
    session.delete(definition)
    if config_row is not None:
        session.delete(config_row)
    session.flush()
    record_audit(
        session,
        action=AuditAction.LIST_COLUMN_REMOVE,
        entity_type=_AUDIT_ENTITY_TYPE,
        entity_id=f"{scope_code}.{column_key}",
        actor=actor,
        before=before,
        after=None,
    )
    return get_config(session, scope_code)


__all__ = [
    "CUSTOM_KEY_PREFIX",
    "add_custom_column",
    "get_config",
    "get_value_labels",
    "list_configs",
    "list_custom_field_options",
    "option_labels_by_code",
    "remove_custom_column",
    "reset_config",
    "save_config",
]
