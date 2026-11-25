"""订单导入只读预检：定位行错误，不从台账汇总虚构业务明细。"""
from __future__ import annotations

from collections import Counter
from datetime import date, datetime
import json
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.business.orders.export_fields import ORDER_DETAIL_EXPORT_COLUMNS
from app.core.errors import Validation
from app.core.security import CurrentUser, PERM_ORDER_UPDATE
from app.domain.trade import Order
from app.shared.scope import owner_scope_filter
from app.shared.form_field_rules import validate_business_responsible

from .details import read_details
from .custom_columns import configured_order_columns, read_custom_order_values
from .events import _EVENT, _operators
from .ledger_reference import ledger_reference_values, reference_errors, reference_labels
from .parser import ImportTable, detail_records
from .reference_codes import resolve_new_account_references

_ORDER_NO = re.compile(r"^(HS|TH|DG)(?!0000)\d{4}$")
_TYPE_LABELS = {"HS": "回收", "TH": "提号", "DG": "代挂"}
_TYPE_VALUES = {"HS": "RECOVERY", "TH": "PICKUP", "DG": "CONSIGNMENT"}
_SUMMARY_COLUMNS = ("成本", "售出金额", "销售金额", "售价", "利润")
_SECTIONS = frozenset({"details", "events", "cashflows", "rebates"})
_SECTION_LABELS = {"details": "详情信息", "events": "操作明细", "cashflows": "资金明细", "rebates": "返点明细"}
_MASTER_FIELDS = frozenset({"行类型", "订单号", "业务日期", "业务类型", "游戏账号/产品", "游戏/产品类型", "订单备注", "业务操作人", "入库操作人"})
_DETAIL_FIELDS = frozenset(label for _key, label, _visible in ORDER_DETAIL_EXPORT_COLUMNS)


def preview_order_import(
    session: Session,
    tables: dict[str, ImportTable],
    *,
    existing: str,
    sections: set[str],
    user: CurrentUser,
) -> dict:
    if existing not in {"skip", "update"} or sections - _SECTIONS:
        raise Validation("导入选项无效")
    main = tables["main"]
    if "订单号" not in main.headers:
        raise Validation("主订单信息缺少订单号列")
    if not main.rows:
        raise Validation("导入文件没有订单数据")

    records = [dict(zip(main.headers, row.values)) for row in main.rows]
    custom_columns = configured_order_columns(session)
    numbers = [record["订单号"].strip().upper() for record in records]
    frequency = Counter(numbers)
    query = select(Order.order_no).where(Order.order_no.in_(set(numbers)))
    all_existing = set(session.scalars(query).all())
    scope = owner_scope_filter(Order.owner_id, user, session)
    visible_existing = set(session.scalars(query.where(scope) if scope is not None else query).all())
    references = {}
    if existing == "update" and user.has(PERM_ORDER_UPDATE) and visible_existing:
        visible_query = select(Order).where(Order.order_no.in_(visible_existing))
        if scope is not None:
            visible_query = visible_query.where(scope)
        references = ledger_reference_values(session, list(session.scalars(visible_query).all()))

    results = []
    for source, record, number in zip(main.rows, records, numbers):
        errors: list[str] = []
        warnings: list[str] = []
        if record.get("行类型", "").strip() not in {"", "明细", "ITEM"}:
            errors.append("仅支持导入订单明细行")
        match = _ORDER_NO.fullmatch(number)
        if not match:
            errors.append("订单号应为 HS、TH 或 DG 加四位数字，且不能为 0000")
        if frequency[number] > 1:
            errors.append("文件中订单号重复")
        if number in all_existing and number not in visible_existing:
            errors.append("订单编号冲突或无权处理")
        elif number in all_existing and existing == "update" and not user.has(PERM_ORDER_UPDATE):
            errors.append("当前角色无权更新订单")

        action = existing if number in visible_existing else "create"
        type_text = record.get("业务类型", "").strip()
        if type_text and match and type_text not in {match.group(1), _TYPE_LABELS[match.group(1)], _TYPE_VALUES[match.group(1)]}:
            errors.append("业务类型与订单编号不一致")
        if action == "create" and not type_text:
            errors.append("新订单缺少业务类型")
        trade_date = record.get("业务日期", "").strip()
        if action == "create" and not trade_date:
            errors.append("新订单缺少业务日期；入库时间不能代替业务日期")
        elif trade_date:
            try:
                if re.fullmatch(r"\d{4}-\d{2}-\d{2}", trade_date):
                    date.fromisoformat(trade_date)
                elif re.match(r"^\d{4}-\d{2}-\d{2}[ T]", trade_date):
                    datetime.fromisoformat(trade_date)
                else:
                    raise ValueError("invalid date")
            except ValueError:
                errors.append("业务日期格式应为 YYYY-MM-DD")
        if action != "skip":
            business_operator = record.get("业务操作人", "").strip()
            inventory_operator = record.get("入库操作人", "").strip()
            if business_operator and inventory_operator and business_operator != inventory_operator:
                errors.append("业务操作人与入库操作人不一致")
            elif match:
                try:
                    operators = _operators(session, business_operator or inventory_operator, {"sheet": source.sheet, "row": source.row})
                    if action == "create" or operators is not None:
                        validate_business_responsible(session, order_type_code=match.group(1), values={"business_responsible_ids": operators})
                except Validation as exc:
                    errors.append(exc.message)
            custom_labels = {label for code, label in custom_columns if match and code == match.group(1)}
            if match:
                try:
                    read_custom_order_values(record, match.group(1), custom_columns)
                except Validation as exc:
                    errors.append(exc.message)
            readonly_labels = reference_labels() if action == "update" and number in references else set()
            if readonly_labels:
                errors.extend(reference_errors(record, references[number]))
            unsupported = [key for key, value in record.items() if key not in _MASTER_FIELDS and key not in _DETAIL_FIELDS and key not in custom_labels and key not in readonly_labels and value.strip()]
            if unsupported:
                errors.append(f"暂不能安全导入的字段：{'、'.join(unsupported)}")
            if "rebates" in sections:
                warnings.append("导入返点会同步登记关联业务事件与资金流水，原登记人仅供参考")
            if "cashflows" in sections:
                warnings.append("已有流水仅在内容一致时识别；关联业务的流水需保留来源凭证")
                if "events" in sections:
                    warnings.append("请确认文件包含全部相关账户的流水；受权限限制的导出可能不完整")
            if "events" in sections:
                warnings.append("操作人按员工名称唯一匹配；买入、售出及取消会同步生成对应资金流水")
            if "details" in sections:
                if action == "update":
                    warnings.append("已有订单的图片、附件、审计等只读详情仅核对并保留，不会通过导入更改")
                else:
                    warnings.append("账号图片、附件等无法从数量或链接恢复；须另行补充原文件")
            for column in _SUMMARY_COLUMNS:
                if record.get(column, "").strip():
                    warnings.append(f"{column}是汇总值，不能直接作为资金明细导入")
        results.append({
            "sheet": source.sheet,
            "row": source.row,
            "order_no": number,
            "action": "error" if errors else action,
            "errors": errors,
            "warnings": warnings,
        })

    available = {name: len(table.rows) for name, table in tables.items() if name != "main"}
    detail_errors = []
    for name in sorted(sections):
        label = _SECTION_LABELS[name]
        table = tables.get(name)
        if table is not None:
            if "订单号" not in table.headers:
                detail_errors.append({"sheet": label, "message": "明细缺少订单号列"})
                continue
            number_index = table.headers.index("订单号")
            for row in table.rows:
                if row.values[number_index].strip().upper() not in frequency:
                    detail_errors.append({"sheet": row.sheet, "row": row.row, "message": "明细的订单号未出现在主订单信息中"})
            continue
        # CSV 导出把明细放在订单行的 JSON 单元格里；无对应列时不能静默忽略选择。
        if name in {"events", "cashflows", "rebates"} and label in main.headers:
            available[name] = 0
            for row, record in zip(main.rows, records):
                raw = record[label].strip()
                if not raw:
                    continue
                try:
                    values = json.loads(raw)
                    if not isinstance(values, list):
                        raise ValueError("not a list")
                    available[name] += len(values)
                except (ValueError, TypeError):
                    detail_errors.append({"sheet": row.sheet, "row": row.row, "message": f"{label}须为明细数组"})
        elif name == "details" and any(header in main.headers for header in ("订单备注", "订单扩展字段", "渠道 / 区服")):
            available[name] = len(main.rows)
        else:
            detail_errors.append({"sheet": label, "message": f"文件缺少所选的{label}"})
    actions = {row["order_no"]: row["action"] for row in results}
    detail_values = {}
    if "details" in sections and not any(error["sheet"] == _SECTION_LABELS["details"] for error in detail_errors):
        try:
            detail_values = read_details(session, tables, records, actions, user)
        except Validation as exc:
            columns = exc.details.get("columns") or []
            detail_errors.append({"sheet": exc.details.get("sheet", _SECTION_LABELS["details"]),
                                  "row": exc.details.get("row"),
                                  "message": exc.message + (f"：{'、'.join(columns)}" if columns else "")})
    for result, record in zip(results, records, strict=True):
        if result["action"] != "create":
            continue
        game_type = record.get("游戏/产品类型", "").strip()
        channel = detail_values.get(result["order_no"], {}).get("channel_region")
        if game_type or channel:
            try:
                resolve_new_account_references(session, game_type, channel)
            except Validation as exc:
                result["errors"].append(exc.message)
                result["action"] = "error"
    for name in ("events", "cashflows", "rebates"):
        if name not in sections or any(error["sheet"] == _SECTION_LABELS[name] for error in detail_errors):
            continue
        try:
            detail_rows = detail_records(tables, records, section=name, label=_SECTION_LABELS[name])
        except Validation as exc:
            detail_errors.append({"sheet": exc.details.get("sheet", _SECTION_LABELS[name]),
                                  "row": exc.details.get("row"), "message": exc.message})
            continue
        for sheet, row_number, item in detail_rows:
            if actions.get(item.get("订单号", "").strip().upper()) == "skip":
                continue
            if name == "events" and item.get("动作", "").strip().upper() not in _EVENT:
                detail_errors.append({"sheet": sheet, "row": row_number, "message": "该操作类型须与对应来源凭证一起处理"})
            if name == "cashflows" and item.get("来源类型", "").strip().upper() not in {"MANUAL", "ORDER_EVENT"}:
                detail_errors.append({"sheet": sheet, "row": row_number, "message": "关联业务的资金流水须连同来源凭证处理"})
    return {"rows": results, "available_sections": available, "selected_sections": sorted(sections), "detail_errors": detail_errors}
