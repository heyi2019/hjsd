"""生成与订单台账导出列兼容的空白导入模板。"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from app.business.orders.export_fields import (
    CASHFLOW_EXPORT_COLUMNS, DETAIL_COLUMNS_MOVED_TO_SHEETS,
    DETAIL_EXPORT_HEADER_GROUPS, DETAIL_EXPORT_SUB_GROUPS, ORDER_DETAIL_EXPORT_COLUMNS,
    ORDER_EVENT_EXPORT_COLUMNS, REBATE_EXPORT_COLUMNS,
)
from app.core.errors import Validation
from app.settings.lists.export import UI_ONLY_KEYS
from app.settings.lists.scopes import LIST_SCOPES
from app.settings.lists.xlsx import new_workbook, write_sheet, xlsx_bytes

_REQUIRED = ("order_no", "trade_date", "inventory_type")
_SECTIONS = frozenset({"details", "events", "cashflows", "rebates"})


def build_order_import_template(columns: Sequence[Mapping[str, Any]], sections: set[str]) -> bytes:
    unknown = sections - _SECTIONS
    if unknown:
        raise Validation("导入明细类型无效", details={"sections": sorted(unknown)})
    ledger = next(scope for scope in LIST_SCOPES if scope.code == "LEDGER")
    defaults = {column.key: column.label for column in ledger.columns}
    defaults["trade_date"] = "业务日期"
    configured = {str(column["key"]): column for column in columns}
    required = [(key, str(configured.get(key, {}).get("label") or defaults[key]), True) for key in _REQUIRED]
    required.append(("business_operator", "业务操作人", True))
    visible = [
        (str(column["key"]), str(column["label"]), True)
        for column in columns
        if column.get("is_visible") and column["key"] not in UI_ONLY_KEYS and column["key"] not in {*_REQUIRED, "business_operator"}
    ]
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
    notes = workbook.create_sheet("填写说明")
    for line in (
        "订单导入模板填写说明",
        "主订单信息：订单号、业务日期、业务类型用于识别新订单；日期填写 YYYY-MM-DD。",
        "示例：订单号 HS0001；业务日期 2026-10-17；业务类型 回收。",
        "业务操作人或入库操作人填写实际员工姓名或用户名，多个操作人用顿号分隔。",
        "台账自定义列按当前订单表单字段配置还原；选择项填写编码或不重名的名称，多选填写 JSON 数组。",
        "数值型自定义列支持整数；无法无损还原的值请通过订单页面录入。",
        "业务日期不等同于入库时间；旧导出未包含业务日期时请补充。",
        "操作、资金和返点明细按订单号关联；每条记录独立占一行。",
        "账号描述适用于回收和代挂；修改已有账号资料请在订单详情中操作。",
        "已有订单的图片、附件、审计等只读详情仅核对原值，不通过导入更改。",
        "新订单中无法还原的详情请先清空对应单元格，图片和附件须在导入后补充原文件。",
        "返点新增时请填写实际资金账户编码；返点会同步生成对应事件和收入流水。",
        "手工资金明细请填写流水号、业务类别编码、核算属性、资金账户编码及来源类型 MANUAL。",
        "运营事件请填写事件号、运营动作、运营详情 JSON；下架需填写关联上架事件号。",
        "同一订单涉及多个明细时，请在各明细表分别填写，不要将汇总值当作明细。",
        "导入前会展示预检结果；不自动匹配或绑定库存账号。",
    ):
        notes.append([line])
    notes.column_dimensions["A"].width = 90
    return xlsx_bytes(workbook)
