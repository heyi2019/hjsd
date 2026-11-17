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
  row_type 是导出专用机器标记（ITEM / TOTAL），保持英文。
"""
from __future__ import annotations

import csv
import io
import json
from typing import Any


def report_csv(
    report: dict[str, Any],
    *,
    columns: list[tuple[str, str, bool]] | None = None,
    value_labels: dict[str, dict[str, str]] | None = None,
    force_registered_keys: bool = False,
) -> str:
    """将报表 items 与 total 统一导出为 UTF-8 CSV，嵌套字段保留为 JSON。"""
    items = report.get("items") if isinstance(report.get("items"), list) else []
    total = report.get("total") if isinstance(report.get("total"), dict) else None
    rows: list[dict[str, Any]] = [
        {"row_type": "ITEM", **item} for item in items if isinstance(item, dict)
    ]
    if total is not None:
        rows.append({"row_type": "TOTAL", **total})
    keys: list[str] = ["row_type"]
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
        fieldnames = ["row_type"]
        for key, _label, visible in columns:
            if (
                visible
                and key != "row_type"
                and (force_registered_keys or key in keys)
                and key not in fieldnames
            ):
                fieldnames.append(key)
        # 只补合计行独有的字段：明细里的 order_id / extra_values 等内部字段不导
        for key in total_only_keys:
            if key not in fieldnames and key not in registered:
                fieldnames.append(key)
        header = ["row_type" if key == "row_type" else labels.get(key, key) for key in fieldnames]

    def normalize(value: Any) -> Any:
        if value is None:
            return ""
        if isinstance(value, (dict, list, tuple)):
            return json.dumps(value, ensure_ascii=False, default=str)
        return value

    def cell(key: str, value: Any) -> Any:
        mapping = value_labels.get(key) if value_labels else None
        if mapping and isinstance(value, str) and value in mapping:
            return mapping[value]
        return normalize(value)

    stream = io.StringIO(newline="")
    writer = csv.DictWriter(
        stream,
        fieldnames=fieldnames,
        extrasaction="ignore",
        lineterminator="\r\n",
    )
    # 表头手工写：fieldnames 是字段键（取值用），首行要中文
    writer.writerow(dict(zip(fieldnames, header)))
    for row in rows:
        writer.writerow({key: cell(key, row.get(key)) for key in fieldnames})
    return "\ufeff" + stream.getvalue()


__all__ = ["report_csv"]
