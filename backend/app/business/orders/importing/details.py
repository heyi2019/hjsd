"""订单详情中可无歧义恢复到订单主档的字段。"""
from __future__ import annotations

from app.core.errors import Validation
from app.business.orders.export_fields import ORDER_DETAIL_EXPORT_COLUMNS

from .parser import ImportTable

_SUPPORTED = {"订单号", "渠道 / 区服", "绑定手机号", "有无二次", "订单备注"}
_SEPARATE_DETAILS = {"操作明细", "资金明细", "返点明细"}
_EMPTY = {"", "-", "[]", "{}", "null"}
_DETAIL_LABELS = {label for _key, label, _visible in ORDER_DETAIL_EXPORT_COLUMNS}


def read_details(tables: dict[str, ImportTable], records: list[dict[str, str]], actions: dict[str, str]) -> dict[str, dict[str, object]]:
    table = tables.get("details")
    if table is not None:
        rows = [(row.sheet, row.row, dict(zip(table.headers, row.values))) for row in table.rows]
    else:
        rows = [(row.sheet, row.row, record) for row, record in zip(tables["main"].rows, records, strict=True)]
    result = {}
    for sheet, row_number, row in rows:
        order_no = row.get("订单号", "").strip().upper()
        if actions.get(order_no) == "skip":
            continue
        if order_no in result:
            raise Validation("订单详情存在重复订单号", details={"sheet": sheet, "row": row_number})
        unsupported = [key for key, value in row.items() if key not in _SUPPORTED and key not in _SEPARATE_DETAILS
                       and (table is not None or key in _DETAIL_LABELS) and value.strip() not in _EMPTY]
        if unsupported:
            raise Validation("订单详情包含不能无损恢复的字段", details={"sheet": sheet, "row": row_number, "columns": unsupported})
        values: dict[str, object] = {}
        for source, target in (("渠道 / 区服", "channel_region"), ("绑定手机号", "bound_phone"), ("订单备注", "note")):
            value = row.get(source, "").strip()
            if value and value != "-":
                values[target] = value
        secondary = row.get("有无二次", "").strip()
        if secondary and secondary != "-":
            normalized = {"有": True, "无": False, "是": True, "否": False, "TRUE": True, "FALSE": False, "1": True, "0": False}.get(secondary.upper())
            if normalized is None:
                raise Validation("有无二次须填写有或无", details={"sheet": sheet, "row": row_number})
            values["has_secondary"] = normalized
        result[order_no] = values
    return result
