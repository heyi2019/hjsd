"""lists.export：业务主列表「按列配置导出 CSV」的通用拼装（主列表与报表共用）。

口径：
- 导出列 = 「设置 → 列表字段」里该 scope 的**可见列**，表头用中文列名、顺序同配置，
  隐藏列不导 —— 保证「界面看到的列 = 导出的列」；
- 自定义列（`extra:{key}`）从行扩展字段（form_extra / extra_values）平铺注入明细行；
- 枚举值按 option_sets / 自定义列选项快照翻中文；
- 行 dict 由各业务 router 组装：筛选、权限、派生列都以列表接口同口径复用，
  这里只做「列 × 行 → CSV」；无 total 时不写合计行；
- `actions` 等纯 UI 列不导出（非数据列，仅行内操作入口）。
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy.orm import Session

from app.core.report_csv import report_csv
from app.settings.lists import service as list_columns_service
from app.settings.lists.export_labels import (
    COLUMN_VALUE_LABELS,
    DETAIL_KEY_LABELS,
    DETAIL_PRUNED_KEYS,
    NESTED_VALUE_LABELS,
)

UI_ONLY_KEYS = frozenset({"actions"})
# 导出行数上限：主列表导出一次性拉全量，防误操作拖垮库；超过时按列表接口同口径截断。
EXPORT_ROW_LIMIT = 10_000


def merge_static_value_labels(
    value_labels: dict[str, dict[str, str]] | None,
) -> dict[str, dict[str, str]]:
    """把闭集系统枚举的静态文案并入动态字典表。

    动态（option_sets / 自定义列快照）优先：管理员改了字典，导出口径跟着变；
    静态表只补没有字典行的列（业务模式 / 业务类型 / 库存状态 / 行标记等）。
    """
    merged: dict[str, dict[str, str]] = {
        key: dict(mapping) for key, mapping in COLUMN_VALUE_LABELS.items()
    }
    for key, mapping in (value_labels or {}).items():
        merged.setdefault(key, {}).update(mapping)
    return merged


def detail_json(value: Any, value_labels: dict[str, dict[str, str]] | None = None) -> str:
    """把详情完整保留为同一 CSV 单元格，并复用列表导出的字典翻译。

    明细 JSON 中文化（2026-11-18）：
    - 字典键按 `DETAIL_KEY_LABELS` 翻中文，`DETAIL_PRUNED_KEYS` 里的系统内部字段剔除；
    - 字典值按「列字典 → 字段级 `NESTED_VALUE_LABELS` → 全局合并字典」的顺序翻译，
      布尔值翻成 是/否；未知键与未知代码值一律保留原样。
    """
    labels = value_labels or {}
    global_labels = {
        raw: translated
        for mapping in labels.values()
        for raw, translated in mapping.items()
    }

    def translate(item: Any, key: str | None = None) -> Any:
        if isinstance(item, dict):
            result: dict[str, Any] = {}
            for name, child in item.items():
                if name in DETAIL_PRUNED_KEYS or child is None:
                    # 系统内部字段与空值（null）都不进导出，减少明细 JSON 噪音
                    continue
                result[DETAIL_KEY_LABELS.get(name, name)] = translate(child, name)
            return result
        if isinstance(item, list):
            return [translate(child, key) for child in item]
        if isinstance(item, bool):
            return "是" if item else "否"
        if isinstance(item, str):
            mapping = labels.get(key or "")
            if mapping and item in mapping:
                return mapping[item]
            nested = NESTED_VALUE_LABELS.get(key or "")
            if nested and item in nested:
                return nested[item]
            return global_labels.get(item, item)
        return item

    translated = translate(value)
    # 顶层标量（如已翻成姓名的经办人列表）直接返回原文，不再包一层 JSON 引号
    if isinstance(translated, str):
        return translated
    return json.dumps(translated, ensure_ascii=False, separators=(",", ":"), default=str)


def inject_custom_columns(
    rows: list[dict[str, Any]], config: dict[str, Any]
) -> list[dict[str, Any]]:
    """把自定义列（`extra:{key}`）的值从行扩展字段平铺进明细行。

    CSV 与 xlsx 导出共用同一份注入逻辑，避免两种格式的取值口径漂移。
    """
    custom_sources = {
        column["key"]: column["source_key"]
        for column in config["columns"]
        if column.get("custom") and column.get("source_key")
    }
    if not custom_sources:
        return list(rows)
    items: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        extras = item.get("extra_values") or item.get("form_extra") or {}
        if isinstance(extras, dict):
            for key, source_key in custom_sources.items():
                item[key] = extras.get(source_key)
        items.append(item)
    return items


def build_list_csv(
    db: Session,
    scope_code: str,
    rows: list[dict[str, Any]],
    *,
    total: dict[str, Any] | None = None,
    extra_columns: list[tuple[str, str, bool]] | None = None,
    include_header: bool = True,
    enforce_row_limit: bool = True,
) -> tuple[str, dict[str, Any]]:
    """按 scope 的列配置把行 dict 列表拼成 CSV 文本。

    CSV 一律**单行表头**：导入解析以首个非空行为表头，多行表头会让回流导入错位。
    需要板块分组/合并表头时走 `lists.xlsx`（导出 Excel）。

    返回 `(csv_text, meta)`，meta 带 `column_count`（可见列数）与
    `translated_columns`（做了值翻译的列键），供审计记录使用。
    """
    config = list_columns_service.get_config(db, scope_code)
    columns = [
        (column["key"], column["label"], column["is_visible"])
        for column in config["columns"]
        if column["key"] not in UI_ONLY_KEYS
    ]
    if extra_columns:
        columns.extend(extra_columns)
    items = inject_custom_columns(rows, config)
    # 导出兜底：无论调用方是否传 limit=None，写出永远不超过 EXPORT_ROW_LIMIT。
    # 与 orders/finance 导出端点的 limit=EXPORT_ROW_LIMIT 形成双保险，
    # 防止后续新增导出端点漏加查询层 limit 时一次性拉爆库或写出超大文件。
    truncated = enforce_row_limit and len(items) > EXPORT_ROW_LIMIT
    if truncated:
        items = items[:EXPORT_ROW_LIMIT]
    report: dict[str, Any] = {"items": items}
    if total is not None:
        report["total"] = total
    csv_text = report_csv(
        report,
        columns=columns,
        value_labels=merge_static_value_labels(
            list_columns_service.get_value_labels(db, scope_code)
        ),
        # 主列表空数据也要完整表头（报表保持旧行为：只导出现过的键）
        force_registered_keys=True,
        # 机器行标记翻中文（明细/合计），与业务人员看到的界面同语言
        row_type_label="行类型",
        include_header=include_header,
    )
    return csv_text, {
        "column_count": sum(1 for _key, _label, visible in columns if visible),
        "translated_columns": sorted(
            list_columns_service.get_value_labels(db, scope_code)
        ),
        "row_count": len(items),
        "truncated": truncated,
    }
