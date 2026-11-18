"""lists.services.custom_columns：自定义列候选、新增与删除。"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.domain.enums import AuditAction
from app.domain.lists import ListColumnConfig, ListCustomColumn
from app.domain.trade import OrderFormField
from app.lists.scopes import get_scope
from app.lists.services._shared import (
    _DATA_KEY_RE,
    _SCOPE_LABELS,
    _AUDIT_ENTITY_TYPE,
    _data_extra_keys,
    _option_items,
    _value_labels,
    CUSTOM_KEY_PREFIX,
)
from app.lists.services.configs import get_config


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
