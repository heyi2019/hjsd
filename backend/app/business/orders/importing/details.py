"""订单详情中可无歧义恢复到订单主档的字段。"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.core.security import CurrentUser
from app.business.inventory._common import validate_account_profile_scope
from app.business.orders.export_fields import ORDER_DETAIL_EXPORT_COLUMNS

from .detail_reference import detail_reference_values, same_readonly_detail
from .parser import ImportTable

_SUPPORTED = {"订单号", "渠道 / 区服", "绑定手机号", "有无二次", "账号描述", "订单备注"}
_SEPARATE_DETAILS = {"操作明细", "资金明细", "返点明细"}
_EMPTY = {"", "-", "[]", "{}", "null"}
_DETAIL_LABELS = {label for _key, label, _visible in ORDER_DETAIL_EXPORT_COLUMNS}
_ACCOUNT_FIELDS = {
    "channel_region": "渠道 / 区服",
    "bound_phone": "绑定手机号",
    "has_secondary": "有无二次",
    "account_description": "账号描述",
}
_REFERENCE_LABELS = _DETAIL_LABELS - _SEPARATE_DETAILS - {"订单备注"}
_ACCOUNT_LABELS = frozenset(_ACCOUNT_FIELDS.values())


def read_details(
    session: Session, tables: dict[str, ImportTable], records: list[dict[str, str]],
    actions: dict[str, str], user: CurrentUser,
) -> dict[str, dict[str, object]]:
    table = tables.get("details")
    if table is not None:
        rows = [(row.sheet, row.row, dict(zip(table.headers, row.values))) for row in table.rows]
    else:
        rows = [(row.sheet, row.row, record) for row, record in zip(tables["main"].rows, records, strict=True)]
    update_numbers = {
        row.get("订单号", "").strip().upper()
        for _, _, row in rows
        if actions.get(row.get("订单号", "").strip().upper()) == "update"
        and any(key in _REFERENCE_LABELS
                and value.strip() and (key in _ACCOUNT_LABELS or value.strip() not in _EMPTY)
                for key, value in row.items())
    }
    references = detail_reference_values(session, update_numbers, user, workbook=table is not None)
    result = {}
    for sheet, row_number, row in rows:
        order_no = row.get("订单号", "").strip().upper()
        if actions.get(order_no) == "skip":
            continue
        if order_no in result:
            raise Validation("订单详情存在重复订单号", details={"sheet": sheet, "row": row_number})
        unsupported = [key for key, value in row.items() if key not in _SUPPORTED and key not in _SEPARATE_DETAILS
                       and (table is not None or key in _DETAIL_LABELS) and value.strip() not in _EMPTY]
        if actions.get(order_no) == "update":
            reference = references.get(order_no, {})
            mismatched = [key for key in unsupported if key in reference and not same_readonly_detail(row[key], reference[key])]
            if mismatched:
                raise Validation("只读详情与当前记录不一致，请核对后重试",
                                 details={"sheet": sheet, "row": row_number, "columns": mismatched})
            unsupported = [key for key in unsupported if key not in reference]
        if unsupported:
            raise Validation("订单详情包含不能无损恢复的字段", details={"sheet": sheet, "row": row_number, "columns": unsupported})
        values: dict[str, object] = {}
        for source, target in (("渠道 / 区服", "channel_region"), ("绑定手机号", "bound_phone"), ("订单备注", "note")):
            value = row.get(source, "").strip()
            if value and value != "-":
                values[target] = value
        description = row.get("账号描述", "").strip()
        if description:
            if len(description) > 2000:
                raise Validation("账号描述不能超过 2000 个字符", details={"sheet": sheet, "row": row_number})
            try:
                validate_account_profile_scope("PICKUP" if order_no.startswith("TH") else None, description, None)
            except Validation as exc:
                raise Validation(exc.message, details={"sheet": sheet, "row": row_number}) from exc
            values["account_description"] = description
        secondary = row.get("有无二次", "").strip()
        if secondary and secondary != "-":
            normalized = {"有": True, "无": False, "是": True, "否": False, "TRUE": True, "FALSE": False, "1": True, "0": False}.get(secondary.upper())
            if normalized is None:
                raise Validation("有无二次须填写有或无", details={"sheet": sheet, "row": row_number})
            values["has_secondary"] = normalized
        if actions.get(order_no) == "update":
            reference = references.get(order_no, {})
            for field, label in _ACCOUNT_FIELDS.items():
                if field not in values:
                    continue
                actual = ("有" if values[field] else "无") if field == "has_secondary" else str(values[field])
                if label not in reference or not same_readonly_detail(actual, reference[label]):
                    raise Validation("更新订单的账号资料需在订单详情中处理",
                                     details={"sheet": sheet, "row": row_number, "columns": [label]})
        result[order_no] = values
    return result
