"""解析订单导出的 CSV / XLSX，保留行号供预检定位。"""
from __future__ import annotations

import csv
import json
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from io import BytesIO, StringIO
from pathlib import PurePath
import re
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile, ZipFile

from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException

from app.core.errors import Validation
from app.core.report_csv import restore_spreadsheet_csv_text

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_EXPANDED_BYTES = 100 * 1024 * 1024
MAX_ROWS = 5000
MAX_COLUMNS = 256
_SHEETS = {
    "主订单信息": ("main", 1),
    "详情信息": ("details", 3),
    "操作明细": ("events", 1),
    "资金明细": ("cashflows", 1),
    "返点明细": ("rebates", 1),
}
_CONTINUATION = re.compile(r"（(?:[2-9]|[1-9]\d+)）$")


@dataclass(frozen=True)
class ImportRow:
    sheet: str
    row: int
    values: tuple[str, ...]


@dataclass(frozen=True)
class ImportTable:
    headers: tuple[str, ...]
    rows: tuple[ImportRow, ...]


def _text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def _headers(values: tuple[str, ...], sheet: str) -> tuple[str, ...]:
    while values and not values[-1].strip():
        values = values[:-1]
    if not values or len(values) > MAX_COLUMNS:
        raise Validation("导入表头为空或列数过多", details={"sheet": sheet})
    result = tuple(value.strip() for value in values)
    if any(not value for value in result):
        raise Validation("导入表头存在空列名", details={"sheet": sheet})
    if len(set(result)) != len(result):
        raise Validation("导入表头存在重复列名", details={"sheet": sheet})
    return result


def _rows(items: Iterable[tuple[int, Sequence[str]]], headers: tuple[str, ...], sheet: str) -> tuple[ImportRow, ...]:
    rows = []
    for row_number, values in items:
        if len(values) > MAX_COLUMNS:
            raise Validation("导入文件列数过多", details={"sheet": sheet, "row": row_number})
        if not any(value.strip() for value in values):
            continue
        if any(value.strip() for value in values[len(headers):]):
            raise Validation("数据包含没有表头的列", details={"sheet": sheet, "row": row_number})
        if len(rows) >= MAX_ROWS:
            raise Validation("导入文件行数过多", details={"sheet": sheet, "limit": MAX_ROWS})
        padded = (*values[:len(headers)], *("" for _ in range(max(0, len(headers) - len(values)))))
        rows.append(ImportRow(sheet, row_number, padded))
    return tuple(rows)


def _csv_table(content: bytes) -> dict[str, ImportTable]:
    try:
        text = content.decode("utf-8-sig")
        reader = csv.reader(StringIO(text, newline=""), strict=True)
        first = next(reader, None)
        if first is None:
            raise Validation("导入文件为空")
        headers = _headers(tuple(first), "订单台账")
        def read_rows():
            next_line = reader.line_num + 1
            for row in reader:
                start_line = next_line
                next_line = reader.line_num + 1
                yield start_line, tuple(restore_spreadsheet_csv_text(value) for value in row)
        rows = _rows(read_rows(), headers, "订单台账")
        return {"main": ImportTable(headers, rows)}
    except (UnicodeDecodeError, csv.Error) as exc:
        raise Validation("CSV 格式无效，请使用 UTF-8 编码") from exc


def _xlsx_tables(content: bytes) -> dict[str, ImportTable]:
    try:
        with ZipFile(BytesIO(content)) as archive:
            files = archive.infolist()
            if len(files) > 1000 or sum(info.file_size for info in files) > MAX_EXPANDED_BYTES:
                raise Validation("Excel 展开后过大")
        workbook = load_workbook(BytesIO(content), read_only=True, data_only=False, keep_links=False)
    except (BadZipFile, OSError, ValueError, KeyError, ParseError, InvalidFileException) as exc:
        raise Validation("Excel 文件格式无效") from exc
    try:
        result: dict[str, ImportTable] = {}
        for sheet in workbook.worksheets:
            base = _CONTINUATION.sub("", sheet.title)
            if base not in _SHEETS:
                continue
            key, header_row = _SHEETS[base]
            if (sheet.max_column or 0) > MAX_COLUMNS or (sheet.max_row or 0) > MAX_ROWS + header_row:
                raise Validation("导入工作表行数或列数过多", details={"sheet": sheet.title})
            table_rows = []
            for index, cells in enumerate(sheet.iter_rows(), 1):
                if index > MAX_ROWS + header_row or len(cells) > MAX_COLUMNS:
                    raise Validation("导入工作表行数或列数过多", details={"sheet": sheet.title})
                if any(cell.data_type == "f" for cell in cells):
                    raise Validation("导入文件不能包含公式，请先粘贴为值", details={"sheet": sheet.title, "row": index})
                table_rows.append((index, tuple(_text(cell.value) for cell in cells)))
            if len(table_rows) < header_row:
                raise Validation("导入工作表缺少表头", details={"sheet": sheet.title})
            headers = _headers(table_rows[header_row - 1][1], sheet.title)
            rows = _rows(table_rows[header_row:], headers, sheet.title)
            previous = result.get(key)
            if previous is not None:
                if previous.headers != headers:
                    raise Validation("同类续表的表头不一致", details={"sheet": sheet.title})
                rows = previous.rows + rows
            if len(rows) > MAX_ROWS:
                raise Validation("导入文件行数过多", details={"sheet": base, "limit": MAX_ROWS})
            result[key] = ImportTable(headers, rows)
        if "main" not in result:
            raise Validation("Excel 缺少主订单信息工作表")
        return result
    except (BadZipFile, OSError, ValueError, KeyError, ParseError, InvalidFileException) as exc:
        raise Validation("Excel 文件格式无效") from exc
    finally:
        workbook.close()


def parse_order_import(filename: str, content: bytes) -> dict[str, ImportTable]:
    if len(content) > MAX_FILE_BYTES:
        raise Validation("导入文件过大，最大支持 10 MB")
    suffix = PurePath(filename).suffix.lower()
    if suffix == ".csv":
        return _csv_table(content)
    if suffix == ".xlsx":
        return _xlsx_tables(content)
    raise Validation("导入文件格式仅支持 CSV 或 XLSX")


def detail_records(
    tables: dict[str, ImportTable], records: list[dict[str, str]], *, section: str, label: str,
) -> list[tuple[str, int, dict[str, str]]]:
    """Excel 明细表和 CSV 单元格中的明细共用行号与订单关联处理。"""
    table = tables.get(section)
    if table is not None:
        return [(row.sheet, row.row, dict(zip(table.headers, row.values))) for row in table.rows]
    result = []
    for source, record in zip(tables["main"].rows, records, strict=True):
        try:
            values = json.loads(record.get(label) or "[]")
            if not isinstance(values, list) or any(not isinstance(value, dict) for value in values):
                raise ValueError("not an object list")
        except (ValueError, TypeError) as exc:
            raise Validation(f"{label}必须是明细对象数组", details={"sheet": source.sheet, "row": source.row}) from exc
        for value in values:
            row = {str(key): "" if item is None else str(item) for key, item in value.items()}
            row["订单号"] = record["订单号"]
            result.append((source.sheet, source.row, row))
    return result
