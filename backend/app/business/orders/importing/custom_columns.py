"""把订单台账中有明确表单定义的自定义列还原为订单字段。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import json

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.business.orders.export_fields import ORDER_DETAIL_EXPORT_COLUMNS
from app.domain.lists import ListCustomColumn
from app.domain.trade import OrderFormField
from app.settings.lists.scopes import SCOPE_MAP
from app.shared.form_field_value import validate_field_value

_RESERVED = {column.label for column in SCOPE_MAP["LEDGER"].columns} | {
    label for _key, label, _visible in ORDER_DETAIL_EXPORT_COLUMNS
} | {"行类型", "业务日期", "业务操作人"}


def configured_order_columns(session: Session) -> dict[tuple[str, str], tuple[ListCustomColumn, OrderFormField] | None]:
    """只有字段来源和当前订单表单均明确时才允许导入。"""
    columns = session.scalars(select(ListCustomColumn).where(ListCustomColumn.scope == "LEDGER")).all()
    definitions = session.scalars(select(OrderFormField).where(
        OrderFormField.order_type_code.in_(("HS", "TH", "DG")),
        OrderFormField.is_custom.is_(True), OrderFormField.is_active.is_(True),
    )).all()
    by_field = {(item.order_type_code, item.field_key): item for item in definitions}
    result = {}
    for column in columns:
        for code in ("HS", "TH", "DG"):
            definition = by_field.get((code, column.source_key))
            if definition is not None and definition.field_type == column.field_type:
                key = (code, column.label)
                result[key] = (column, definition) if key not in result and column.label not in _RESERVED else None
    return result


def _selection(value: str, labels: dict[str, str], *, label: str) -> str:
    candidates = {code for code, display in labels.items() if value in {code, display}}
    if len(candidates) > 1:
        raise Validation(f"字段 {label} 的选项编码或名称不唯一，请调整字段配置")
    return next(iter(candidates)) if candidates else value


def read_custom_order_values(
    record: dict[str, str], code: str,
    columns: dict[tuple[str, str], tuple[ListCustomColumn, OrderFormField] | None],
) -> tuple[dict[str, object], set[str]]:
    values: dict[str, object] = {}
    account_fields: set[str] = set()
    for label, raw in record.items():
        key = (code, label)
        if key not in columns or raw == "":
            continue
        configured = columns[key]
        if configured is None:
            raise Validation(f"字段 {label} 与其他列重名，无法确定导入来源")
        column, definition = configured
        kind = definition.field_type
        text = raw if kind == "TEXT" else raw.strip()
        if kind in {"TEXT", "SELECT", "DATE"}:
            value: object = text
            if kind == "SELECT":
                value = _selection(text, column.value_labels or {}, label=label)
            elif kind == "DATE":
                try:
                    try:
                        value = date.fromisoformat(text).isoformat()
                    except ValueError:
                        value = datetime.fromisoformat(text).date().isoformat()
                except ValueError as exc:
                    raise Validation(f"字段 {label} 的日期无效") from exc
        elif kind == "BOOLEAN":
            options = {"true": True, "false": False, "1": True, "0": False, "是": True, "否": False}
            if text.lower() not in options:
                raise Validation(f"字段 {label} 须填写是或否")
            value = options[text.lower()]
        elif kind == "MULTI_SELECT":
            try:
                items = json.loads(text)
                if not isinstance(items, list) or any(not isinstance(item, str) for item in items):
                    raise ValueError("not a string list")
                value = [_selection(item, column.value_labels or {}, label=label) for item in items]
            except (TypeError, ValueError) as exc:
                raise Validation(f"字段 {label} 须填写 JSON 选项数组") from exc
        elif kind == "NUMBER":
            try:
                number = Decimal(text)
                if not number.is_finite() or number != number.to_integral_value() or abs(number) > 999_999_999_999_999:
                    raise ValueError("not a safe integer")
                value = int(number)
            except (InvalidOperation, ValueError) as exc:
                raise Validation(f"字段 {label} 的值无法无损导入，请在订单页面录入") from exc
        else:
            raise Validation(f"字段 {label} 的值无法无损导入，请在订单页面录入")
        validate_field_value(definition, value, strict=False)
        values[column.source_key] = value
        if definition.section == "ACCOUNT_PRODUCT":
            account_fields.add(column.source_key)
    return values, account_fields
