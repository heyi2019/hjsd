"""生成订单导入使用的空白模板。"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from openpyxl.utils import get_column_letter
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation

from app.business.orders.export_fields import (
    CASHFLOW_EXPORT_COLUMNS, DETAIL_COLUMNS_MOVED_TO_SHEETS,
    DETAIL_EXPORT_HEADER_GROUPS, DETAIL_EXPORT_SUB_GROUPS, ORDER_DETAIL_EXPORT_COLUMNS,
    ORDER_EVENT_EXPORT_COLUMNS, REBATE_EXPORT_COLUMNS,
)
from app.core.errors import Validation
from app.domain.enums import AccountingAttribute
from app.settings.lists.export import UI_ONLY_KEYS
from app.settings.lists.scopes import LIST_SCOPES
from app.settings.lists.xlsx import new_workbook, write_sheet, xlsx_bytes
from .parser import MAX_COLUMNS, MAX_ROWS

_REQUIRED = ("stock_no", "order_no", "business_mode", "inventory_type")
_SECTIONS = frozenset({"details", "events", "cashflows", "rebates"})
_FINANCE_COLUMNS = (
    ("inventory_entry_at", "入库时间"), ("recovery_price", "回收价"), ("pickup_price", "提号价"),
    ("sale_at", "售卖时间"), ("sale_operator", "售卖操作人"), ("sale_amount", "售出金额"),
    ("account_status", "库存状态"), ("profit_base", "代挂利润"),
)


def build_order_import_template(columns: Sequence[Mapping[str, Any]], sections: set[str], *,
                                pool_codes: Sequence[str] = (), operators: Sequence[str] = (),
                                custom_choices: Mapping[str, Sequence[str]] | None = None) -> bytes:
    unknown = sections - _SECTIONS
    if unknown:
        raise Validation("导入明细类型无效", details={"sections": sorted(unknown)})
    ledger = next(scope for scope in LIST_SCOPES if scope.code == "LEDGER")
    defaults = {column.key: column.label for column in ledger.columns}
    configured = {str(column["key"]): column for column in columns}
    required = [(key, str(defaults[key] if key in {"stock_no", "business_mode"}
                          else configured.get(key, {}).get("label") or defaults[key]), True) for key in _REQUIRED]
    required.append(("inventory_operator", "入库操作人", True))
    visible = []
    finance_labels = dict(_FINANCE_COLUMNS)
    for column in columns:
        key = str(column["key"])
        if not column.get("is_visible") or key in UI_ONLY_KEYS or key in {*_REQUIRED, "trade_date", "business_operator", "inventory_operator", "account_status", "in_hand_time"}:
            continue
        if key == "cost_amount":
            visible.extend((("recovery_price", "回收价", True), ("pickup_price", "提号价", True)))
        elif key in finance_labels:
            visible.append((key, finance_labels[key], True))
        else:
            visible.append((key, str(column["label"]), True))
    included = {key for key, _label, _visible in required + visible}
    for key, label in _FINANCE_COLUMNS:
        if key not in included:
            index = next((i for i, item in enumerate(visible) if item[0] == "profit_base"), len(visible)) if key == "account_status" else len(visible)
            visible.insert(index, (key, label, True))
    labels = [label for _key, label, _visible in required + visible]
    if len(labels) != len(set(labels)):
        raise Validation("导入模板的列名重复，请先调整列表自定义列")
    workbook = new_workbook()
    write_sheet(workbook, title="主订单信息", rows=[], columns=required + visible)
    if "details" in sections:
        write_sheet(
            workbook, title="详情信息", rows=[],
            columns=[("order_no", "订单号", True), *[column for column in ORDER_DETAIL_EXPORT_COLUMNS if column[0] not in DETAIL_COLUMNS_MOVED_TO_SHEETS]],
            header_groups={key: value for key, value in DETAIL_EXPORT_HEADER_GROUPS.items() if key not in DETAIL_COLUMNS_MOVED_TO_SHEETS},
            sub_header_groups=DETAIL_EXPORT_SUB_GROUPS,
        )
    for key, title, definitions in (
        ("events", "操作明细", ORDER_EVENT_EXPORT_COLUMNS),
        ("cashflows", "资金明细", CASHFLOW_EXPORT_COLUMNS),
        ("rebates", "返点明细", REBATE_EXPORT_COLUMNS),
    ):
        if key in sections:
            write_sheet(workbook, title=title, rows=[], columns=definitions)
    choices = {
        "主订单信息": {"业务模式": ["自营", "分销"], "业务类型": ["回收", "提号", "代挂"], "入库操作人": operators},
        "详情信息": {"有无二次": ["有", "无"]},
        "操作明细": {"动作": ["买入", "售出", "交付", "取消", "运营", "返点"],
                     "运营动作": ["寄售", "下架", "更新图片", "更新描述"],
                     "结算方式": ["全款"], "交付方向": ["买号", "卖号"],
                     "金额归属": ["本金", "利润", "总额"], "已过账": ["是"],
                     "资金账户编码": pool_codes, "操作人": operators},
        "资金明细": {"方向": ["收入", "支出"], "资金账户编码": pool_codes,
                     "核算属性": list(AccountingAttribute.values()),
                     "来源类型": ["MANUAL", "ORDER_EVENT"], "操作人": operators},
        "返点明细": {"返点类型": ["买号返点", "卖号返点"], "资金账户编码": pool_codes,
                     "操作人": operators},
    }
    choices["主订单信息"].update(custom_choices or {})
    options = workbook["主订单信息"]
    for sheet_name, fields in choices.items():
        if sheet_name not in workbook:
            continue
        sheet = workbook[sheet_name]
        header_row = 3 if sheet_name == "详情信息" else 1
        headers = {cell.value: cell.column for cell in sheet[header_row]}
        for label, values in fields.items():
            values = list(dict.fromkeys(value for value in values if value))
            if label not in headers or not values:
                continue
            option_column = options.max_column + 1
            first_row = 2
            if option_column > MAX_COLUMNS or len(values) > MAX_ROWS:
                raise Validation("模板下拉选项超过工作表容量")
            options.cell(row=1, column=option_column, value=f"__import_options_{option_column}__")
            options.column_dimensions[get_column_letter(option_column)].hidden = True
            for row, value in enumerate(values, first_row):
                options.cell(row=row, column=option_column, value=value)
            name = f"import_options_{option_column}"
            letter = get_column_letter(option_column)
            workbook.defined_names.add(DefinedName(
                name, attr_text=f"'{options.title}'!${letter}${first_row}:${letter}${first_row + len(values) - 1}",
            ))
            validation = DataValidation(type="list", formula1=name, allow_blank=True, showErrorMessage=False)
            sheet.add_data_validation(validation)
            col = get_column_letter(headers[label])
            validation.add(f"{col}{header_row + 1}:{col}{header_row + 5000}")
    return xlsx_bytes(workbook)
