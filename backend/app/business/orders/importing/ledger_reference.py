"""已有订单的台账派生列只做只读核对，不能当作可写业务事实。"""
from __future__ import annotations

import csv
from decimal import Decimal, InvalidOperation
from io import StringIO

from sqlalchemy.orm import Session

from app.business.orders.router_outputs.list_payload import _order_list_payload
from app.core.report_csv import report_csv, restore_spreadsheet_csv_text
from app.domain.trade import Order
from app.settings.lists.export import merge_static_value_labels
from app.settings.lists.scopes import SCOPE_MAP
from app.settings.lists.service import get_value_labels

_KEYS = frozenset({
    "stock_no", "inventory_entry_at", "cost_amount", "business_mode", "sale_at",
    "sale_operator", "sale_amount", "status", "account_status", "profit_base",
})
_COLUMNS = [(column.key, column.label, True) for column in SCOPE_MAP["LEDGER"].columns if column.key in _KEYS]
_LABELS = {label: key for key, label, _visible in _COLUMNS}
_MONEY = frozenset({"cost_amount", "sale_amount", "profit_base"})


def ledger_reference_values(session: Session, orders: list[Order]) -> dict[str, dict[str, str]]:
    if not orders:
        return {}
    rows = _order_list_payload(session, orders)
    for row in rows:
        row["business_mode"] = row.get("account_business_mode")
    # 复用正式导出格式及字典，避免导入侧维护另一套状态与日期文案。
    text = report_csv({"items": rows}, columns=[("order_no", "订单号", True), *_COLUMNS],
                      value_labels=merge_static_value_labels(get_value_labels(session, "LEDGER")),
                      force_registered_keys=True)
    return {row["订单号"]: {key: restore_spreadsheet_csv_text(value) for key, value in row.items()}
            for row in csv.DictReader(StringIO(text.lstrip("\ufeff")))}


def reference_errors(record: dict[str, str], reference: dict[str, str]) -> list[str]:
    errors = []
    for label, key in _LABELS.items():
        raw = record.get(label, "").strip()
        if not raw:
            continue
        expected = reference.get(label, "").strip()
        if key in _MONEY:
            try:
                actual_amount, expected_amount = Decimal(raw), Decimal(expected)
                equal = actual_amount.is_finite() and expected_amount.is_finite() and actual_amount == expected_amount
            except InvalidOperation:
                equal = False
        else:
            equal = raw == expected
        if not equal:
            errors.append(f"{label}与系统当前值不一致，请通过对应业务明细修改")
    return errors


def reference_labels() -> set[str]:
    return set(_LABELS)
