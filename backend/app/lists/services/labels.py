"""lists.services.labels：列值中文映射（字典 + 自定义列选项快照）。"""
from __future__ import annotations

from collections.abc import Collection

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.options import OptionSet
from app.lists.scopes import get_scope
from app.lists.services._shared import _custom_rows_for_scope


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
