"""订单导入写入：复用订单事务与审计，不把汇总值伪造成流水。"""
from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.business.orders.create import create_order
from app.business.orders.mutations import update_order
from app.core.errors import Validation
from app.core.security import CurrentUser
from app.domain.foundation import DocumentSequence
from app.domain.trade import Account, Order
from app.settings.field_definitions.order_types import get_order_type_by_code
from app.shared.game_references import game_reference_labels

from .parser import ImportTable
from .preview import preview_order_import
from .custom_columns import configured_order_columns, read_custom_order_values
from .cashflows import import_cashflows
from .events import _operators, import_events
from app.shared.form_field_rules import validate_business_responsible
from .details import read_details
from .rebates import import_rebates
from .reference_codes import resolve_new_account_references


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
    sections: set[str], user: CurrentUser,
) -> dict:
    # 一个文件作为一个工作单元；即使调用方捕获校验异常，已处理的行也不会残留。
    with session.begin_nested():
        return _execute_order_import(session, tables, existing=existing, sections=sections, user=user)


def _execute_order_import(
    session: Session, tables: dict[str, ImportTable], *, existing: str,
    sections: set[str], user: CurrentUser,
) -> dict:
    preview = preview_order_import(session, tables, existing=existing, sections=sections, user=user)
    if preview["detail_errors"] or any(row["errors"] for row in preview["rows"]):
        raise Validation("导入预检未通过，请修正后重试", details={"preview": preview})
    if sections - {"rebates", "cashflows", "events", "details"}:
        raise Validation("所选明细暂不能导入，请等待明细校验完成")
    records = [dict(zip(tables["main"].headers, row.values)) for row in tables["main"].rows]
    # 先锁全部涉及的序列，再重新检查重号与权限，避免预检后被并发建单抢占。
    _reserve_numbers(session, [row["order_no"] for row in preview["rows"] if row["action"] == "create"])
    preview = preview_order_import(session, tables, existing=existing, sections=sections, user=user)
    if preview["detail_errors"] or any(row["errors"] for row in preview["rows"]):
        raise Validation("导入期间订单状态发生变化，请重新预检", details={"preview": preview})
    actions = {row["order_no"]: row["action"] for row in preview["rows"]}
    detail_values = read_details(session, tables, records, actions, user) if "details" in sections else {}
    custom_columns = configured_order_columns(session)
    game_labels, channel_labels = game_reference_labels(session)

    created = updated = skipped = 0
    update_numbers = [row["order_no"] for row in preview["rows"] if row["action"] == "update"]
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
        trade_date_text = record.get("业务日期", "").strip()
        details = detail_values.get(number, {})
        main_note = record.get("订单备注", "").strip()
        detail_note = str(details.get("note") or "")
        if main_note and detail_note and main_note != detail_note:
            raise Validation("主订单与详情中的订单备注不一致", details={"order_no": number})
        note = main_note or detail_note
        operators = _operators(session, record.get("业务操作人", "").strip() or record.get("入库操作人", "").strip(),
                               {"sheet": result["sheet"], "row": result["row"]})
        custom_values, account_fields = read_custom_order_values(record, number[:2], custom_columns)
        if operators is not None:
            validate_business_responsible(session, order_type_code=number[:2], values={"business_responsible_ids": operators})
        if result["action"] == "update":
            order = session.scalar(select(Order).where(Order.order_no == number))
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
            if trade_date_text:
                changes["trade_date"] = date.fromisoformat(trade_date_text[:10])
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
        if (game_type or snapshot_extra or account_fields) and not account:
            raise Validation("填写账号详情时须同时填写游戏账号/产品", details={"order_no": number})
        if game_type or snapshot_extra.get("channel_region"):
            game_type, channel = resolve_new_account_references(session, game_type, snapshot_extra.get("channel_region"))
            if channel:
                snapshot_extra["channel_region"] = channel
        snapshot = {"game_account": account, **({"game_type": game_type} if game_type else {}), **snapshot_extra} if account else None
        if operators is not None:
            custom_values["business_responsible_ids"] = operators
        create_order(session, order_type=number[:2], trade_date=date.fromisoformat(trade_date_text[:10]),
                     account_snapshot=snapshot, actor=user.username, note=note or None, user=user,
                     imported_order_no=number, bind_inventory=False,
                     form_extra=custom_values or None)
        created += 1
    # 返点服务会生成对应事件与流水，先恢复来源凭证，再匹配文件中的事件和流水。
    rebate_created = rebate_updated = 0
    if "rebates" in sections:
        rebate_created, rebate_updated = import_rebates(session, tables, records, actions, user,
                                                        include_events="events" in sections)
    events_created = events_matched = 0
    deferred_events: set[str] = set()
    if "events" in sections:
        events_created, events_matched, deferred_events = import_events(session, tables, records, actions, user,
                                                                       include_cashflows="cashflows" in sections)
    flow_created = flow_matched = 0
    flow_renumbered = []
    if "cashflows" in sections:
        flow_created, flow_matched, flow_renumbered = import_cashflows(session, tables, records, actions, user,
                                                                      deferred_events=deferred_events)
    session.flush()
    return {"created": created, "updated": updated, "skipped": skipped,
            "events_created": events_created, "events_matched": events_matched,
            "cashflows_created": flow_created, "cashflows_matched": flow_matched,
            "cashflows_renumbered": flow_renumbered,
            "rebates_created": rebate_created, "rebates_updated": rebate_updated, "rows": preview["rows"]}
