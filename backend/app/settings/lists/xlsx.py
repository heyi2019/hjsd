"""lists.xlsx：主列表导出 Excel 的通用拼装（多 sheet、多级表头合并、基础样式）。

与 `lists.export`（CSV）的分工：
- CSV 面向机器读取与既有下载链，单表、无样式、恒单行表头；
- xlsx 面向人看，可多 sheet、可**真合并**表头单元格、带列宽/冻结/边框。

两侧共用同一份输入（「列配置 + 行 dict」）与同一套值翻译口径，
避免同一次导出在两个格式里字段或中文不一致。
"""
from __future__ import annotations

import io
import json
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

# Excel 单元格字符上限 32767；留余量后截断，超限内容单格塞不进去（openpyxl 会抛错）。
EXCEL_SHEET_ROW_LIMIT = 1_048_576
EXCEL_CELL_LIMIT = 32_000
TRUNCATED_SUFFIX = "…（已截断）"

_HEADER_FILL = PatternFill("solid", fgColor="1F4E79")
_GROUP_FILL = PatternFill("solid", fgColor="2E75B6")
_SUBGROUP_FILL = PatternFill("solid", fgColor="5B9BD5")
_HEADER_FONT = Font(color="FFFFFF", bold=True, size=10)
_BODY_FONT = Font(size=10)
_THIN = Side(style="thin", color="BFBFBF")
_BORDER = Border(left=_THIN, right=_THIN, top=_THIN, bottom=_THIN)
_HEADER_ALIGN = Alignment(horizontal="center", vertical="center", wrap_text=True)
_BODY_ALIGN = Alignment(vertical="top", wrap_text=False)

# 列宽估算：中文按 2 个字符宽计，夹在 [MIN, MAX] 之间
_MIN_WIDTH = 8
_MAX_WIDTH = 42


def _display_width(text: str) -> int:
    return sum(2 if ord(char) > 0x2E80 else 1 for char in text)


def _cell_value(value: Any, value_labels: dict[str, str] | None) -> Any:
    """把行 dict 的值转成 openpyxl 可写的类型，并复用列表导出的字典翻译。"""
    if value is None:
        return None
    if isinstance(value, Decimal):
        # 金额保持数值型，Excel 里可直接求和；二维小数足够，避免 float 尾差
        return float(round(value, 2))
    if isinstance(value, (datetime, date)):
        return value
    if isinstance(value, (dict, list, tuple)):
        text = json.dumps(value, ensure_ascii=False, default=str)
    elif isinstance(value, str):
        text = value_labels.get(value, value) if value_labels else value
    else:
        return value
    if len(text) > EXCEL_CELL_LIMIT:
        return text[:EXCEL_CELL_LIMIT] + TRUNCATED_SUFFIX
    return text


def new_workbook() -> Workbook:
    """新建空 workbook 并移除 openpyxl 自带默认 sheet，让第一个写入的 sheet 成为首页。"""
    workbook = Workbook()
    workbook.remove(workbook.active)
    return workbook


def _style_group_cell(cell, fill: PatternFill) -> None:
    cell.fill = fill
    cell.font = _HEADER_FONT
    cell.alignment = _HEADER_ALIGN


def _write_group_rows(
    sheet: Worksheet,
    groups: list[str],
    subgroups: list[str],
    *,
    has_sub_row: bool,
) -> None:
    """写一级（第 1 行）与二级（第 2 行）分组表头，按连续同组做横向合并。

    `has_sub_row` 为 False 时只有一级分组，第 2 行留给列名，不得占用。

    - 一级块内**存在二级分组**时：第 1 行整块合并，第 2 行按二级分块合并；
      块内没有二级的列（如有）在第 2 行留空，归属由上一行的合并区表达。
    - 一级块内**不存在二级分组**时：第 1 行整块合并显示组名，第 2 行同范围留空，
      让所有列的表头高度一致（列名统一在最后一行）。
    """
    total = len(groups)
    start = 0
    for index in range(1, total + 1):
        is_last = index == total
        if not is_last and groups[index] == groups[start]:
            continue

        name = groups[start]
        block_has_sub = has_sub_row and any(
            subgroups[position] for position in range(start, index)
        )

        if name:
            if index - start > 1:
                sheet.merge_cells(
                    start_row=1, start_column=start + 1, end_row=1, end_column=index
                )
            # 无二级时第 2 行留空但同样合并，保证表头区视觉连续
            if has_sub_row and not block_has_sub and index - start > 1:
                sheet.merge_cells(
                    start_row=2, start_column=start + 1, end_row=2, end_column=index
                )
            _style_group_cell(sheet.cell(row=1, column=start + 1, value=name), _GROUP_FILL)

        if block_has_sub:
            sub_start = start
            for position in range(start + 1, index + 1):
                if position == index or subgroups[position] != subgroups[sub_start]:
                    sub_name = subgroups[sub_start]
                    if sub_name:
                        if position - sub_start > 1:
                            sheet.merge_cells(
                                start_row=2,
                                start_column=sub_start + 1,
                                end_row=2,
                                end_column=position,
                            )
                        _style_group_cell(
                            sheet.cell(row=2, column=sub_start + 1, value=sub_name),
                            _SUBGROUP_FILL,
                        )
                    sub_start = position

        start = index


def write_sheet(
    workbook: Workbook,
    *,
    title: str,
    rows: list[dict[str, Any]],
    columns: list[tuple[str, str, bool]],
    value_labels: dict[str, dict[str, str]] | None = None,
    header_groups: dict[str, str] | None = None,
    sub_header_groups: dict[str, str] | None = None,
    freeze_key_column: bool = True,
) -> Worksheet:
    """按 Excel 的单表容量自动续表，返回首张工作表。"""
    header_rows = 1 + bool(header_groups) + bool(header_groups and sub_header_groups)
    capacity = EXCEL_SHEET_ROW_LIMIT - header_rows
    if capacity <= 0:
        raise ValueError("工作表容量不足以容纳表头")
    first_sheet: Worksheet | None = None
    for index, start in enumerate(range(0, max(len(rows), 1), capacity), start=1):
        suffix = f"（{index}）" if index > 1 else ""
        sheet_title = f"{title[:31 - len(suffix)]}{suffix}"
        sheet = _write_single_sheet(
            workbook, title=sheet_title, rows=rows[start:start + capacity], columns=columns,
            value_labels=value_labels, header_groups=header_groups,
            sub_header_groups=sub_header_groups, freeze_key_column=freeze_key_column,
        )
        if first_sheet is None:
            first_sheet = sheet
    assert first_sheet is not None
    return first_sheet


def _write_single_sheet(
    workbook: Workbook,
    *,
    title: str,
    rows: list[dict[str, Any]],
    columns: list[tuple[str, str, bool]],
    value_labels: dict[str, dict[str, str]] | None = None,
    header_groups: dict[str, str] | None = None,
    sub_header_groups: dict[str, str] | None = None,
    freeze_key_column: bool = True,
) -> Worksheet:
    """往 workbook 里写一个 sheet：多级（可选）合并表头 + 数据行 + 列宽冻结。

    - `columns` 的第三位为可见性，隐藏列不写；
    - `header_groups` 给了就写分组表头：第一行板块名并按连续同组合并；
    - `sub_header_groups` 给了就再多一行二级分组（如「交付信息」下分「买号交付 / 卖号交付」），
      列名行随之下移到第 3 行；
    - `value_labels` 只翻译「字符串且命中字典」的值，与 CSV 同口径；
    - 冻结窗格固定在表头下方（`freeze_key_column` 时同时冻结首列）。
    """
    sheet = workbook.create_sheet(title=title)
    visible = [(key, label) for key, label, is_visible in columns if is_visible]
    if not visible:
        sheet.cell(row=1, column=1, value="（无可导出列）")
        return sheet

    has_groups = bool(header_groups)
    has_subgroups = has_groups and bool(sub_header_groups)
    header_row_count = 1 + (1 if has_groups else 0) + (1 if has_subgroups else 0)
    column_labels = [label for _key, label in visible]

    if has_groups:
        groups = [header_groups.get(key, "") for key, _label in visible]
        subgroups = (
            [sub_header_groups.get(key, "") for key, _label in visible]
            if has_subgroups and sub_header_groups
            else ["" for _key, _label in visible]
        )
        _write_group_rows(sheet, groups, subgroups, has_sub_row=has_subgroups)

    label_row = header_row_count
    for column_index, label in enumerate(column_labels, start=1):
        cell = sheet.cell(row=label_row, column=column_index, value=label)
        cell.fill = _HEADER_FILL
        cell.font = _HEADER_FONT
        cell.alignment = _HEADER_ALIGN

    body_start = header_row_count + 1
    for row_offset, row in enumerate(rows):
        excel_row = body_start + row_offset
        for column_index, (key, _label) in enumerate(visible, start=1):
            labels = value_labels.get(key) if value_labels else None
            cell = sheet.cell(
                row=excel_row, column=column_index, value=_cell_value(row.get(key), labels)
            )
            cell.font = _BODY_FONT
            cell.alignment = _BODY_ALIGN

    # 表头区域补边框（含被合并单元格覆盖的每一格，否则合并后边框缺失）
    for row_index in range(1, header_row_count + 1):
        for column_index in range(1, len(visible) + 1):
            sheet.cell(row=row_index, column=column_index).border = _BORDER

    # 列宽按「表头 + 前 200 行样本」估算，明细 JSON 列受 _MAX_WIDTH 上限保护
    sample = rows[:200]
    for column_index, (key, label) in enumerate(visible, start=1):
        widest = _display_width(label)
        for row in sample:
            value = row.get(key)
            if value is None:
                continue
            text = value if isinstance(value, str) else str(value)
            widest = max(widest, _display_width(text[:60]))
        sheet.column_dimensions[get_column_letter(column_index)].width = min(
            max(widest + 2, _MIN_WIDTH), _MAX_WIDTH
        )

    sheet.freeze_panes = (
        f"{'B' if freeze_key_column else 'A'}{body_start}"
    )
    sheet.auto_filter.ref = (
        f"A{label_row}:{get_column_letter(len(visible))}{body_start + len(rows) - 1}"
        if rows
        else None
    )
    return sheet


def xlsx_bytes(workbook: Workbook) -> bytes:
    """把 workbook 序列化成字节流；调用方负责写响应头。"""
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()
