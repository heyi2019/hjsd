"""订单导入写入：复用订单事务与审计，按确认的规则生成历史收支。"""
from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.business.collaboration import create_cashflow
from app.business.orders.create import create_order
from app.business.orders.events import post_event
from app.business.orders.mutations import update_order
from app.core.errors import Validation
from app.core.security import CurrentUser
from app.domain.enums import AccountingAttribute, CashflowSourceType, Direction
from app.domain.foundation import DocumentSequence
from app.domain.trade import Account, Order
from app.settings.field_definitions.order_types import get_order_type_by_code
from app.settings.field_definitions.pools import require_default_pool
from app.shared.game_references import game_reference_labels

from .parser import ImportTable
from .preview import preview_order_import
from .custom_columns import configured_order_columns, read_custom_order_values
from .cashflows import import_cashflows
from .events import _operators, import_events
from .ledger_finance import PRICE_COLUMNS, HistoricalFinance, historical_finance
from .inventory import create_order_inventory, imports_inventory, inventory_entry_time, reserve_stock_numbers, stock_number
from .history import capture_before, record_import
from app.shared.form_field_rules import validate_business_responsible
from .details import read_details
from .rebates import import_rebates
from .reference_codes import resolve_new_account_references


def _create_historical_finance(
    session: Session, order: Order, record: dict[str, str], finance: HistoricalFinance,
    *, user: CurrentUser, inventory_operators: list[int] | None, pool_id: int,
) -> tuple[int, int]:
    event_count = flow_count = 0
    if finance.buy_amount is not None:
        assert finance.buy_on is not None
        _, flow = post_event(
            session, order.id, event_type="BUY", amount=finance.buy_amount,
            occurred_on=finance.buy_on, pool_id=pool_id, portion="PRINCIPAL",
            operator_user_ids=inventory_operators, actor=user.username, user=user,
            note=f"历史导入：入库时间 {record['入库时间']}", historical_import=True,
        )
        event_count += 1
        flow_count += int(flow is not None)
    if finance.sale_amount is not None:
        assert finance.sale_on is not None
        sale_operators = _operators(session, record.get("售卖操作人", ""), {})
        sale_event, flow = post_event(
            session, order.id, event_type="SELL", amount=finance.sale_amount,
            occurred_on=finance.sale_on, pool_id=pool_id, portion="GROSS", sale_mode="FULL",
            operator_user_ids=sale_operators, actor=user.username, user=user,
            note=f"历史导入：售卖时间 {record['售卖时间']}", historical_import=True,
            historical_cashflows_supplied=order.order_type == "DG",
            historical_sale_at=finance.sale_at,
        )
        event_count += 1
        flow_count += int(flow is not None)
        if order.order_type == "DG" and finance.profit:
            create_cashflow(
                session, pool_id=pool_id, occurred_on=finance.sale_on,
                direction=Direction.IN.value, category="SELL", amount=finance.profit,
                accounting_attribute=AccountingAttribute.DG_REVENUE.value,
                order_id=order.id, source_type=CashflowSourceType.ORDER_EVENT.value,
                source_id=sale_event.event_no, operator_user_ids=sale_operators,
                note="历史导入：代挂按代挂利润登记收入", actor=user.username, user=user,
                form_extra_scope=None,
            )
            flow_count += 1
    return event_count, flow_count


def _reserve_numbers(session: Session, numbers: list[str]) -> None:
    """按类型稳定顺序锁序列；显式导入号码不让后续普通建单再次发出。"""
    grouped: dict[str, list[int]] = {}
    for number in numbers:
        grouped.setdefault(number[:2], []).append(int(number[2:]))
    for code in sorted(grouped):
        definition = get_order_type_by_code(session, code)
        if definition is None:
            raise Validation("业务类型不存在", details={"order_type": code})
        sequence = session.scalar(select(DocumentSequence).where(
            DocumentSequence.sequence_key == definition.sequence_key
        ).with_for_update().execution_options(populate_existing=True))
        if sequence is None or sequence.prefix != code:
            raise Validation("订单编号序列配置无效", details={"order_type": code})
        sequence.current_value = max(sequence.current_value, max(grouped[code]))
    session.flush()


def execute_order_import(
    session: Session, tables: dict[str, ImportTable], *, existing: str,
    sections: set[str], user: CurrentUser, file_name: str = "订单文件",
) -> dict:
    # 一个文件作为一个工作单元；即使调用方捕获校验异常，已处理的行也不会残留。
    with session.begin_nested():
        main = tables["main"]
        numbers = [dict(zip(main.headers, row.values)).get("订单号", "").strip().upper() for row in main.rows]
        before = capture_before(session, numbers)
        result = _execute_order_import(session, tables, existing=existing, sections=sections, user=user)
        result["batch_id"] = record_import(session, before=before, result=result, file_name=file_name, user=user)
        return result


def _execute_order_import(
    session: Session, tables: dict[str, ImportTable], *, existing: str,
    sections: set[str], user: CurrentUser,
) -> dict:
    preview = preview_order_import(session, tables, existing=existing, sections=sections, user=user)
    if preview["detail_errors"] or any(row["errors"] for row in preview["rows"]):
        raise Validation("导入预检未通过，请修正后重试", details={"preview": preview})
    records = [dict(zip(tables["main"].headers, row.values)) for row in tables["main"].rows]
    inventory_mode = imports_inventory(tables["main"].headers)
    inventory_rows = [(row, record) for row, record in zip(preview["rows"], records, strict=True)
                      if inventory_mode and row["action"] in {"create", "inventory"}]
    if inventory_rows:
        reserve_stock_numbers(session, [number for _row, record in inventory_rows if (number := stock_number(record))])
    # 先锁全部涉及的序列，再重新检查重号与权限，避免预检后被并发建单抢占。
    _reserve_numbers(session, [row["order_no"] for row in preview["rows"] if row["action"] == "create"])
    preview = preview_order_import(session, tables, existing=existing, sections=sections, user=user)
    if preview["detail_errors"] or any(row["errors"] for row in preview["rows"]):
        raise Validation("导入期间订单状态发生变化，请重新预检", details={"preview": preview})
    actions = {row["order_no"]: row["action"] for row in preview["rows"]}
    detail_values = read_details(session, tables, records, actions, user) if "details" in sections else {}
    custom_columns = configured_order_columns(session)
    game_labels, channel_labels = game_reference_labels(session)

    created = updated = skipped = inventories_created = 0
    auto_events = auto_flows = 0
    finance_pool_id: int | None = None
    update_numbers = [row["order_no"] for row in preview["rows"] if row["action"] in {"update", "inventory"}]
    if update_numbers:
        session.scalars(select(Order).where(Order.order_no.in_(update_numbers)).order_by(Order.id).with_for_update()
                        .execution_options(populate_existing=True)).all()
        locked_preview = preview_order_import(session, tables, existing=existing, sections=sections, user=user)
        if locked_preview["detail_errors"] or any(row["errors"] for row in locked_preview["rows"]):
            raise Validation("导入期间订单状态发生变化，请重新预检", details={"preview": locked_preview})
    for result, record in sorted(zip(preview["rows"], records, strict=True), key=lambda item: item[0]["order_no"]):
        number = result["order_no"]
        if result["action"] == "skip":
            skipped += 1
            continue
        if result["action"] == "inventory":
            order = session.scalar(select(Order).where(Order.order_no == number))
            if order is None:
                raise Validation("订单状态已变化，请重新预检", details={"order_no": number})
            create_order_inventory(session, order, record, actor=user.username,
                                   finance=historical_finance(record, number[:2]), existing_order=True)
            inventories_created += 1
            continue
        details = detail_values.get(number, {})
        main_note = record.get("订单备注", "").strip()
        detail_note = str(details.get("note") or "")
        if main_note and detail_note and main_note != detail_note:
            raise Validation("主订单与详情中的订单备注不一致", details={"order_no": number})
        note = main_note or detail_note
        operators = _operators(session, record.get("入库操作人", "").strip(),
                               {"sheet": result["sheet"], "row": result["row"]})
        order = session.scalar(select(Order).where(Order.order_no == number)) if result["action"] == "update" else None
        custom_values, account_fields = read_custom_order_values(record, number[:2], custom_columns, existing_order=order)
        if operators is not None and result["action"] == "update":
            validate_business_responsible(session, order_type_code=number[:2], values={"business_responsible_ids": operators})
        if result["action"] == "update":
            if order is None:
                raise Validation("订单状态已变化，请重新预检", details={"order_no": number})
            snapshot = order.account_snapshot or {}
            account = session.get(Account, order.account_id) if order.account_id is not None else None
            for column, key in (("游戏账号/产品", "game_account"), ("游戏/产品类型", "game_type")):
                value = record.get(column, "").strip()
                current = (getattr(account, key, None) if account else None) or snapshot.get(key) or ""
                accepted = {current}
                if key == "game_type":
                    if snapshot.get(key) == current:
                        accepted.add(snapshot.get("game_type_label"))
                    accepted.add(game_labels.get(current))
                if value and value not in accepted:
                    raise Validation("更新订单的账号资料需在订单详情中处理", details={"order_no": number, "field": column})
            for key in ("channel_region", "bound_phone", "has_secondary", "account_description"):
                current = getattr(account, key, None) if account else snapshot.get(key)
                accepted = {current}
                if key == "channel_region":
                    if snapshot.get(key) == current:
                        accepted.add(snapshot.get("channel_region_label"))
                    accepted.add(channel_labels.get(current))
                if key in details and details[key] not in accepted:
                    raise Validation("更新订单的账号资料需在订单详情中处理", details={"order_no": number, "field": key})
            for key in account_fields:
                current_extras = (account.form_extra or {}) if account else (snapshot.get("extra_values") or {})
                if custom_values[key] != current_extras.get(key):
                    raise Validation("更新订单的账号资料需在订单详情中处理", details={"order_no": number, "field": key})
                custom_values.pop(key)
            changes = {}
            if note:
                changes["note"] = note
            if custom_values or operators is not None:
                changes["form_extra"] = {**(order.form_extra or {}), **custom_values}
                if operators is not None:
                    changes["form_extra"]["business_responsible_ids"] = operators
                changes["form_extra_scope"] = number[:2]
            if changes:
                update_order(session, order.id, actor=user.username, user=user, **changes)
            updated += 1
            continue
        account = record.get("游戏账号/产品", "").strip()
        game_type = record.get("游戏/产品类型", "").strip()
        snapshot_extra = {key: details[key] for key in ("channel_region", "bound_phone", "has_secondary", "account_description") if key in details}
        if game_type or snapshot_extra.get("channel_region"):
            game_type, channel = resolve_new_account_references(session, game_type, snapshot_extra.get("channel_region"))
            if channel:
                snapshot_extra["channel_region"] = channel
        snapshot = {
            **({"game_account": account} if account else {}),
            **({"game_type": game_type} if game_type else {}),
            **snapshot_extra,
        } if account or game_type or snapshot_extra or account_fields else None
        if operators is not None:
            custom_values["business_responsible_ids"] = operators
        source_reference = ({key: record[key].strip() for key in ("库存编号", "业务模式", "库存状态")
                             if record.get(key, "").strip()} if PRICE_COLUMNS.intersection(record) else {})
        entry_time = inventory_entry_time(record)
        order = create_order(session, order_type=number[:2], trade_date=entry_time.date() if entry_time else date.today(),
                             account_snapshot=snapshot, actor=user.username, note=note or None, user=user,
                             imported_order_no=number, bind_inventory=False,
                             historical_import_reference=source_reference or None,
                             form_extra=custom_values or None)
        finance = historical_finance(record, number[:2])
        account = None
        if inventory_mode:
            account = create_order_inventory(session, order, record, actor=user.username,
                                             finance=finance, existing_order=False)
            inventories_created += 1
        if finance is not None and (finance.buy_amount is not None or finance.sale_amount is not None):
            if finance_pool_id is None:
                finance_pool_id = require_default_pool(session).id
            event_count, flow_count = _create_historical_finance(
                session, order, record, finance, user=user, inventory_operators=operators, pool_id=finance_pool_id,
            )
            auto_events += event_count
            auto_flows += flow_count
        if account is not None and finance is not None and finance.buy_on is not None:
            account.buy_date = finance.buy_on
        created += 1
    # 返点服务会生成对应事件与流水，先恢复来源凭证，再匹配文件中的事件和流水。
    rebate_created = rebate_updated = 0
    if "rebates" in sections:
        rebate_created, rebate_updated = import_rebates(session, tables, records, actions, user,
                                                        include_events="events" in sections)
    events_created, events_matched = auto_events, 0
    deferred_events: set[str] = set()
    if "events" in sections:
        detail_events, events_matched, deferred_events = import_events(session, tables, records, actions, user,
                                                                      include_cashflows="cashflows" in sections)
        events_created += detail_events
    flow_created, flow_matched = auto_flows, 0
    flow_renumbered = []
    if "cashflows" in sections:
        detail_flows, flow_matched, flow_renumbered = import_cashflows(session, tables, records, actions, user,
                                                                     deferred_events=deferred_events)
        flow_created += detail_flows
    session.flush()
    return {"created": created, "updated": updated, "skipped": skipped, "inventories_created": inventories_created,
            "events_created": events_created, "events_matched": events_matched,
            "cashflows_created": flow_created, "cashflows_matched": flow_matched,
            "cashflows_renumbered": flow_renumbered,
            "rebates_created": rebate_created, "rebates_updated": rebate_updated, "rows": preview["rows"]}
