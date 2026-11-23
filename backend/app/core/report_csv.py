"""core.report_csv：报表 / 主列表统一的 CSV 行格式化器（2026-11-18 归位 core 层）。

归位原因：本函数是零领域依赖的纯格式化器（rows × columns → CSV 文本），
但原先放在 reporting/export.py —— 该模块顶部还拉起 profit/r2/r3/r5 等重报表
实现（间接依赖 orders），导致 lists.export -> reporting.export 形成跨域环
（stocks -> lists -> reporting -> orders -> stocks）。归位 core 后，
lists.export 与 stocks 台账导出只依赖 core，环断。

口径（沿用原 reporting.export 实现，未做任何行为变更）：
- `columns` = 该报表对应列表作用域的**全部登记列** [(字段键, 中文表头, 是否可见)]：
  只导可见列、顺序同配置；「已登记但被隐藏」的列一律剔除；
  明细行里**未登记**的键一律不导；唯一例外是合计行独有的键，追加在末尾；
  传 None 时退回「数据里出现什么键就导什么列」的旧行为。
- `force_registered_keys`：True 时可见登记列无论行里是否出现过都进表头
  （主列表导出空数据也要完整表头）。
- `value_labels` = {列 key: {代码值: 中文}}：只翻译「字符串且命中字典」的单元格；
  row_type 是导出专用机器标记（ITEM / TOTAL）：取值可经 value_labels["row_type"] 翻中文，
  表头文案由 `row_type_label` 控制（默认保持 "row_type"，主列表导出走 build_list_csv
  统一翻成「行类型 / 明细 / 合计」）。
"""
from __future__ import annotations

import csv
import io
import json
import re
from typing import Any


ROW_TYPE_KEY = "row_type"
_NUMBER_TEXT = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\Z")


def _formula_like_csv_text(value: str) -> bool:
    if not value:
        return False
    stripped = value.lstrip(" \t\r\n\0")
    leading = value[:len(value) - len(stripped)]
    if any(char in "\t\r\n\0" for char in leading):
        return True
    if not stripped or stripped in {"+", "-"}:
        return False
    if stripped[0] in "+-" and _NUMBER_TEXT.fullmatch(stripped.strip()):
        return False
    return stripped[0] in "=+-@＝＋－＠"


def spreadsheet_csv_cell(value: Any) -> Any:
    """CSV 没有单元格类型，为公式样式文本加引号标记；数值保持原样。"""
    if not isinstance(value, str):
        return value
    # 已有的前导单引号也转义一层，以便导入时可无歧义恢复原文。
    without_quotes = value.lstrip("'")
    if _formula_like_csv_text(value) or (without_quotes != value and _formula_like_csv_text(without_quotes)):
        return "'" + value
    return value


def restore_spreadsheet_csv_text(value: str) -> str:
    """恢复本系统 CSV 导出添加的单引号，供兼容导入使用。"""
    if value.startswith("'") and _formula_like_csv_text(value.lstrip("'")):
        return value[1:]
    return value


def report_csv(
    report: dict[str, Any],
    *,
    columns: list[tuple[str, str, bool]] | None = None,
    value_labels: dict[str, dict[str, str]] | None = None,
    force_registered_keys: bool = False,
    row_type_label: str = ROW_TYPE_KEY,
    include_header: bool = True,
) -> str:
    """将报表 items 与 total 统一导出为 UTF-8 CSV，嵌套字段保留为 JSON。"""
    items = report.get("items") if isinstance(report.get("items"), list) else []
    total = report.get("total") if isinstance(report.get("total"), dict) else None
    rows: list[dict[str, Any]] = [
        {ROW_TYPE_KEY: "ITEM", **item} for item in items if isinstance(item, dict)
    ]
    if total is not None:
        rows.append({ROW_TYPE_KEY: "TOTAL", **total})
    keys: list[str] = [ROW_TYPE_KEY]
    for row in rows:
        for key in row:
            if key not in keys:
                keys.append(key)
    if len(keys) == 1:
        keys.extend(["items", "total"])
    item_keys: set[str] = {
        key for item in items if isinstance(item, dict) for key in item
    }
    # 只认「合计行独有」的键：明细里也出现过的未登记字段不算，
    # 否则界面没登记的明细字段会从合计行漏回导出表。
    total_only_keys: list[str] = [
        key for key in (total.keys() if total is not None else ()) if key not in item_keys
    ]

    if columns is None:
        fieldnames = list(keys)
        header = list(keys)
    else:
        labels = {key: label for key, label, _visible in columns}
        registered = {key for key, _label, _visible in columns}
        fieldnames = [ROW_TYPE_KEY]
        for key, _label, visible in columns:
            if (
                visible
                and key != ROW_TYPE_KEY
                and (force_registered_keys or key in keys)
                and key not in fieldnames
            ):
                fieldnames.append(key)
        # 只补合计行独有的字段：明细里的 order_id / extra_values 等内部字段不导
        for key in total_only_keys:
            if key not in fieldnames and key not in registered:
                fieldnames.append(key)
        header = [
            row_type_label if key == ROW_TYPE_KEY else labels.get(key, key)
            for key in fieldnames
        ]

    def normalize(value: Any) -> Any:
        if value is None:
            return ""
        if isinstance(value, (dict, list, tuple)):
            return json.dumps(value, ensure_ascii=False, default=str)
        return value

    def cell(key: str, value: Any) -> Any:
        mapping = value_labels.get(key) if value_labels else None
        if mapping and isinstance(value, str) and value in mapping:
            value = mapping[value]
        return spreadsheet_csv_cell(normalize(value))

    stream = io.StringIO(newline="")
    writer = csv.DictWriter(
        stream,
        fieldnames=fieldnames,
        extrasaction="ignore",
        lineterminator="\r\n",
    )
    # 表头手工写：fieldnames 是字段键（取值用），首行要中文
    if include_header:
        writer.writerow(dict(zip(fieldnames, map(spreadsheet_csv_cell, header))))
    for row in rows:
        writer.writerow({key: cell(key, row.get(key)) for key in fieldnames})
    return ("\ufeff" if include_header else "") + stream.getvalue()


__all__ = ["report_csv", "spreadsheet_csv_cell", "restore_spreadsheet_csv_text"]
