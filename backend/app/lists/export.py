"""lists.export：业务主列表「按列配置导出 CSV」的通用拼装（主列表与报表共用）。

口径：
- 导出列 = 「设置 → 列表字段」里该 scope 的**可见列**，表头用中文列名、顺序同配置，
  隐藏列不导 —— 保证「界面看到的列 = 导出的列」；
- 自定义列（`extra:{key}`）从行扩展字段（form_extra / extra_values）平铺注入明细行；
- 枚举值按 option_sets / 自定义列选项快照翻中文；
- 行 dict 由各业务 router 组装：筛选、脱敏、池权限、派生列都以列表接口同口径复用，
  这里只做「列 × 行 → CSV」；无 total 时不写合计行；
- `actions` 等纯 UI 列不导出（注册表里锁定是为了「不可隐藏」，不是数据列）。
"""
from __future__ import annotations

from typing import Any
from urllib.parse import quote

from fastapi import Response
from sqlalchemy.orm import Session

from app.lists import service as list_columns_service
from app.reporting.service import report_csv

UI_ONLY_KEYS = frozenset({"actions"})
# 导出行数上限：主列表导出一次性拉全量，防误操作拖垮库；超过时按列表接口同口径截断。
EXPORT_ROW_LIMIT = 10_000


def build_list_csv(
    db: Session,
    scope_code: str,
    rows: list[dict[str, Any]],
    *,
    total: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    """按 scope 的列配置把行 dict 列表拼成 CSV 文本。

    返回 `(csv_text, meta)`，meta 带 `column_count`（可见列数）与
    `translated_columns`（做了值翻译的列键），供审计记录使用。
    """
    config = list_columns_service.get_config(db, scope_code)
    columns = [
        (column["key"], column["label"], column["is_visible"])
        for column in config["columns"]
        if column["key"] not in UI_ONLY_KEYS
    ]
    custom_sources = {
        column["key"]: column["source_key"]
        for column in config["columns"]
        if column.get("custom") and column.get("source_key")
    }
    items: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        extras = item.get("extra_values") or item.get("form_extra") or {}
        if isinstance(extras, dict):
            for key, source_key in custom_sources.items():
                item[key] = extras.get(source_key)
        items.append(item)
    report: dict[str, Any] = {"items": items}
    if total is not None:
        report["total"] = total
    csv_text = report_csv(
        report,
        columns=columns,
        value_labels=list_columns_service.get_value_labels(db, scope_code),
        # 主列表空数据也要完整表头（报表保持旧行为：只导出现过的键）
        force_registered_keys=True,
    )
    return csv_text, {
        "column_count": sum(1 for _key, _label, visible in columns if visible),
        "translated_columns": sorted(
            list_columns_service.get_value_labels(db, scope_code)
        ),
    }


def csv_file_response(csv_text: str, filename: str) -> Response:
    """统一的 CSV 下载响应；中文文件名走 RFC 5987 `filename*`（HTTP 头只允许 latin-1）。"""
    if filename.isascii():
        disposition = f'attachment; filename="{filename}"'
    else:
        disposition = f"attachment; filename*=UTF-8''{quote(filename)}"
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": disposition},
    )
