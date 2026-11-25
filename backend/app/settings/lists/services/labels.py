"""lists.services.labels：列值中文映射（字典 + 自定义列选项快照）。"""
from __future__ import annotations

from collections.abc import Collection

from sqlalchemy.orm import Session

from app.shared.game_references import game_reference_labels
from app.shared.option_snapshots import option_label_maps
from app.settings.lists.scopes import get_scope
from app.settings.lists.services._shared import _current_field_option_labels, _custom_rows_for_scope


def option_labels_by_code(
    session: Session, codes: Collection[str]
) -> dict[str, dict[str, str]]:
    """按字典 code 批量取 {code: {代码值: 中文}}。

    事实源是 `option_sets` 表；字典行缺失或选项为空时该组为空，导出保留原值，
    不因字典缺失而失败。主列表列值翻译与订单台账明细 sheet 共用这一入口。
    """
    labels: dict[str, dict[str, str]] = {}
    for (group, value), label in option_label_maps(session, set(codes)).items():
        labels.setdefault(group, {})[value] = label
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
    if scope_code in {"LEDGER", "INVENTORY"}:
        games, _channels = game_reference_labels(session)
        result["account_game_type"] = games
    if scope_code == "CASHFLOW":
        result["category"] = {
            **option_labels_by_code(session, {"STUDIO_EXPENSE_ITEM"}).get("STUDIO_EXPENSE_ITEM", {}),
            "studio_income_item_01": "货款",
            "studio_income_item_02": "其他",
        }
    customs = _custom_rows_for_scope(session, scope_code)
    current_labels = _current_field_option_labels(session, customs.values())
    for column_key, definition in customs.items():
        labels = {**current_labels.get(definition.source_key, {}), **(definition.value_labels or {})}
        if labels:
            result[column_key] = labels
    return result
