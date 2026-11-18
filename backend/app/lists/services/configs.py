"""lists.services.configs：列表列显示配置的读取、整表保存与恢复默认。"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import NotFound, Validation
from app.domain.enums import AuditAction
from app.domain.lists import ListColumnConfig
from app.lists.scopes import LIST_SCOPES, get_scope
from app.lists.services._shared import (
    _AUDIT_ENTITY_TYPE,
    _all_custom_rows,
    _config_snapshot,
    _custom_rows_for_scope,
    _merge,
    _rows_for_scope,
)


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
