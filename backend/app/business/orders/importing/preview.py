"""订单导入只读预检：校验主表、资金生成条件与明细。"""
from __future__ import annotations

from collections import Counter
from functools import lru_cache
import json
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.business.orders.export_fields import ORDER_DETAIL_EXPORT_COLUMNS
from app.core.errors import Validation
from app.core.security import CurrentUser, PERM_FINANCE_ORDER_EVENT_POST, PERM_ORDER_EVENT_POST, PERM_ORDER_UPDATE
from app.domain.trade import Account, Order, OrderEvent
from app.shared.scope import owner_scope_filter
from app.shared.form_field_rules import validate_business_responsible
from app.shared.order_amounts import order_cashflow_profit_by_order
from app.settings.field_definitions.classification import BUSINESS_CLASSIFICATION
from app.settings.lists.export_labels import COLUMN_VALUE_LABELS

from .details import read_details
from .custom_columns import configured_order_columns, read_custom_order_values
from .events import _EVENT, _operators
from .ledger_finance import FINANCE_COLUMNS, PRICE_COLUMNS, historical_finance
from .inventory import imports_inventory, inventory_entry_time, stock_number, verify_existing_order
from .ledger_reference import ledger_reference_values, reference_errors, reference_labels
from .parser import ImportTable, detail_records
from .reference_codes import resolve_new_account_references
from app.settings.field_definitions.pools import require_default_pool

_ORDER_NO = re.compile(r"^(HS|TH|DG)(?!0000)\d{4}$")
_SUMMARY_COLUMNS = ("成本", "售出金额", "利润")
_SECTION_LABELS = {"details": "详情信息", "events": "操作明细", "cashflows": "资金明细", "rebates": "返点明细"}
_SECTIONS = frozenset(_SECTION_LABELS)
_MASTER_FIELDS = frozenset({"行类型", "订单号", "业务类型", "游戏账号/产品", "游戏/产品类型", "订单备注", "入库操作人", "入库时间"})
_LEGACY_MAIN_FIELDS = frozenset({"业务操作人", "在手时间", "利润"})
_DETAIL_FIELDS = frozenset(label for _key, label, _visible in ORDER_DETAIL_EXPORT_COLUMNS)


def preview_order_import(
    session: Session,
    tables: dict[str, ImportTable],
    *,
    existing: str,
    sections: set[str],
    user: CurrentUser,
) -> dict:
    if existing not in {"skip", "update", "inventory"} or sections - _SECTIONS:
        raise Validation("导入选项无效")
    main = tables["main"]
    legacy_fields = _LEGACY_MAIN_FIELDS.intersection(main.headers)
    finance_mode = bool(PRICE_COLUMNS.intersection(main.headers))
    inventory_mode = imports_inventory(main.headers)
    if existing == "inventory" and (not inventory_mode or sections):
        raise Validation("补库存须使用包含库存列和价格列的主表，不能同时选择明细")
    if "订单号" not in main.headers:
        raise Validation("主订单信息缺少订单号列")
    if not main.rows:
        raise Validation("导入文件没有订单数据")

    @lru_cache(maxsize=None)
    def operator_error(order_type: str, raw: str, creating: bool) -> str | None:
        try:
            operators = _operators(session, raw, {})
            if creating or operators is not None:
                validate_business_responsible(session, order_type_code=order_type, values={"business_responsible_ids": operators})
        except Validation as exc:
            return exc.message
        return None

    @lru_cache(maxsize=None)
    def resolve_reference(game_type: str, channel: str | None) -> tuple[str, str | None]:
        return resolve_new_account_references(session, game_type, channel)

    @lru_cache(maxsize=None)
    def reference_error(game_type: str, channel: str | None) -> str | None:
        try:
            resolve_reference(game_type, channel)
        except Validation as exc:
            return exc.message
        return None

    @lru_cache(maxsize=1)
    def finance_pool() -> tuple[str | None, str | None]:
        if not (user.has(PERM_ORDER_EVENT_POST) or user.has(PERM_FINANCE_ORDER_EVENT_POST)):
            return None, "当前角色无权登记订单资金流水"
        try:
            pool = require_default_pool(session)
        except Validation as exc:
            return None, exc.message
        if not user.can_see_pool(pool.id):
            return None, "当前用户无权使用默认资金账户"
        return pool.name, None

    @lru_cache(maxsize=None)
    def sale_operator_error(raw: str) -> str | None:
        try:
            _operators(session, raw, {})
        except Validation as exc:
            return exc.message
        return None

    records = [dict(zip(main.headers, row.values)) for row in main.rows]
    custom_columns = configured_order_columns(session)
    numbers = [record["订单号"].strip().upper() for record in records]
    frequency = Counter(numbers)
    query = select(Order.order_no).where(Order.order_no.in_(set(numbers)))
    all_existing = set(session.scalars(query).all())
    scope = owner_scope_filter(Order.owner_id, user, session)
    visible_existing = set(session.scalars(query.where(scope)).all()) if scope is not None else all_existing
    ledger_labels = reference_labels()
    references = {}
    visible_orders = {}
    if existing in {"update", "inventory"} and user.has(PERM_ORDER_UPDATE) and visible_existing:
        visible_query = select(Order).where(Order.order_no.in_(visible_existing))
        if scope is not None:
            visible_query = visible_query.where(scope)
        visible_orders = {order.order_no: order for order in session.scalars(visible_query).all()}
        if existing == "update":
            reference_numbers = {
                number for number, record in zip(numbers, records, strict=True)
                if number in visible_orders and any(record.get(label, "").strip() for label in ledger_labels)
            }
            references = ledger_reference_values(session, [visible_orders[number] for number in reference_numbers])

    stock_frequencies = Counter(record.get("库存编号", "").strip().upper() for record in records if record.get("库存编号", "").strip())
    stocks_by_number = {item.stock_no: item for item in session.scalars(select(Account).where(
        Account.stock_no.in_(stock_frequencies)
    )).all()} if inventory_mode and stock_frequencies else {}
    existing_accounts = {item.id: item for item in session.scalars(select(Account).where(
        Account.id.in_([order.account_id for order in visible_orders.values() if order.account_id is not None])
    )).all()} if existing == "inventory" and visible_orders else {}
    events_by_order: dict[int, list[OrderEvent]] = {}
    if existing == "inventory" and visible_orders:
        for event in session.scalars(select(OrderEvent).where(OrderEvent.order_id.in_([order.id for order in visible_orders.values()]))).all():
            events_by_order.setdefault(event.order_id, []).append(event)
    profits = order_cashflow_profit_by_order(session, order_ids=[order.id for order in visible_orders.values()]) if existing == "inventory" else {}

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
        elif number in all_existing and existing in {"update", "inventory"} and not user.has(PERM_ORDER_UPDATE):
            errors.append("当前角色无权更新订单")

        action = existing if number in visible_existing else "create"
        if existing == "inventory" and number not in visible_existing:
            errors.append("补库存只处理已有订单")
            action = "skip"
        order = visible_orders.get(number) if existing == "inventory" else None
        if action == "inventory" and order and order.account_id is not None:
            account = existing_accounts.get(order.account_id)
            requested_number = record.get("库存编号", "").strip().upper()
            if account is None or (requested_number and account.stock_no != requested_number):
                errors.append("订单已关联其他库存，不能重复补库存")
            action = "skip"
        if legacy_fields and action != "update":
            errors.append(f"不支持旧版导入字段，请使用当前模板：{'、'.join(sorted(legacy_fields))}")
        finance = None
        type_text = record.get("业务类型", "").strip()
        if type_text and match:
            code = match.group(1)
            business_type = BUSINESS_CLASSIFICATION[code]["business_type"]
            if type_text not in {code, business_type, COLUMN_VALUE_LABELS["inventory_type"][business_type]}:
                errors.append("业务类型与订单编号不一致")
        if action == "create" and not type_text:
            errors.append("新订单缺少业务类型")
        if action == "create":
            try:
                if inventory_entry_time(record) is None:
                    warnings.append("未填写入库时间，将使用订单创建时间作为订单日期和入库时间")
            except Validation as exc:
                errors.append(exc.message)
        if action != "skip":
            inventory_operator = record.get("入库操作人", "").strip()
            if match and action != "inventory":
                error = operator_error(match.group(1), inventory_operator, action == "create")
                if error is not None:
                    errors.append(error)
            custom_labels = {label for code, label in custom_columns if match and code == match.group(1)}
            if match and action != "inventory":
                try:
                    read_custom_order_values(record, match.group(1), custom_columns,
                                             existing_order=visible_orders.get(number) if action == "update" else None)
                except Validation as exc:
                    errors.append(exc.message)
            readonly_labels = ledger_labels if action == "update" and number in references else set()
            if readonly_labels:
                reference_record = record
                if visible_orders[number].account_id is None and record.get("入库时间", "").strip():
                    reference_record = {**record, "入库时间": ""}
                    warnings.append("已有订单未关联库存，入库时间仅供参考，不会修改订单日期")
                errors.extend(reference_errors(reference_record, references[number]))
            accepted_finance = FINANCE_COLUMNS | {"业务模式", "库存编号", "库存状态"} if finance_mode else frozenset()
            ignored_display_fields = {"在手时间"} if action == "update" else set()
            unsupported = [key for key, value in record.items() if key not in _MASTER_FIELDS and key not in ignored_display_fields and key not in _DETAIL_FIELDS and key not in custom_labels and key not in readonly_labels and key not in accepted_finance and value.strip()]
            if unsupported:
                errors.append(f"暂不能安全导入的字段：{'、'.join(unsupported)}")
            if inventory_mode and action in {"create", "inventory"}:
                try:
                    number_value = stock_number(record)
                    if number_value and stock_frequencies[number_value] > 1:
                        errors.append("文件中库存编号重复")
                    if number_value and number_value in stocks_by_number:
                        errors.append("库存编号已存在，不能重复导入")
                    if action == "inventory" and inventory_entry_time(record) is None:
                        warnings.append("未填写入库时间，将使用订单创建时间")
                except Validation as exc:
                    errors.append(exc.message)
                warnings.append("将创建库存并自动判断在库或出库状态" if action == "create" else "将为已有订单补库存，不重复生成订单、事件或流水")
            if match and finance_mode:
                try:
                    finance = historical_finance(record, match.group(1))
                except Validation as exc:
                    errors.append(exc.message)
                if finance is not None:
                    if action == "update":
                        errors.append("已有订单不能通过主表重复生成资金流水，请跳过或使用资金明细核对")
                    if action != "inventory" and sections.intersection({"events", "cashflows", "rebates"}):
                        errors.append("主表自动生成流水不能与操作、资金或返点明细同时导入")
                    if record.get("售卖操作人", "").strip() and finance.sale_amount is None:
                        errors.append("填写售卖操作人时须填写售出金额和售卖时间")
                    operator_error_value = sale_operator_error(record.get("售卖操作人", ""))
                    if operator_error_value is not None:
                        errors.append(operator_error_value)
                    if action != "inventory" and (finance.buy_amount is not None or finance.sale_amount is not None):
                        pool_name, pool_error = finance_pool()
                        if pool_error:
                            errors.append(pool_error)
                        else:
                            warnings.append(f"将使用默认资金账户 {pool_name} 生成历史订单事件和资金流水")
                    if action != "inventory" and match.group(1) == "DG" and finance.sale_amount is not None:
                        warnings.append("代挂按代挂利润登记收入，售出金额只记录售出事件")
            if action == "inventory" and order:
                try:
                    game_value = record.get("游戏/产品类型", "").strip()
                    resolved_game = resolve_reference(game_value, None)[0] if game_value else None
                    verify_existing_order(order, record, finance, events_by_order.get(order.id, []),
                                          profits.get(order.id, 0), resolved_game or None)
                except Validation as exc:
                    errors.append(exc.message)
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
                if finance is None and record.get(column, "").strip():
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
            error = reference_error(game_type, channel)
            if error is not None:
                result["errors"].append(error)
                result["action"] = "error"
    if inventory_mode:
        unsold: dict[str, list[tuple[dict, str | None]]] = {}
        for result, record in zip(results, records, strict=True):
            identifier = record.get("游戏账号/产品", "").strip()
            if result["action"] not in {"create", "inventory"} or not identifier:
                continue
            finance = historical_finance(record, result["order_no"][:2])
            if finance is not None and finance.sale_amount is not None:
                continue
            game_name = record.get("游戏/产品类型", "").strip()
            try:
                game_value = resolve_reference(game_name, None)[0] if game_name else None
            except Validation:
                continue
            unsold.setdefault(identifier, []).append((result, game_value or None))
        waiting_by_identifier: dict[str, list[Account]] = {}
        if unsold:
            for account in session.scalars(select(Account).where(
                Account.game_account.in_(unsold), Account.status == "WAITING",
            )).all():
                waiting_by_identifier.setdefault(account.game_account, []).append(account)
        for identifier, candidates in unsold.items():
            by_game = Counter(game for _result, game in candidates)
            missing_game = by_game.get(None, 0)
            for result, game in candidates:
                duplicated_file = (len(candidates) > 1 if game is None else by_game[game] > 1 or missing_game > 0)
                duplicated_stock = any(game is None or account.game_type == game for account in waiting_by_identifier.get(identifier, []))
                if duplicated_file or duplicated_stock:
                    result["errors"].append("游戏账号已在库或在文件中重复在库")
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
