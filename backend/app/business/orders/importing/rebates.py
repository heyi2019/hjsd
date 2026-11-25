"""返点明细导入：以返点单号去重，通过返点服务同步事件与流水。"""
from __future__ import annotations

from datetime import date, datetime
import json
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.business.collaboration import create_rebate, update_rebate
from app.core.errors import PermissionDenied, Validation
from app.core.money import to_money
from app.core.security import CurrentUser, PERM_ORDER_EVENT_POST
from app.domain.trade import Cashflow, Order, OrderEvent, RebateRecord

from .parser import ImportTable, detail_records
from .events import _operators
from .reference_codes import resolve_pool_code

_TYPE = {"BUY": "BUY", "SELL": "SELL", "买号返点": "BUY", "卖号返点": "SELL"}


def import_rebates(
    session: Session, tables: dict[str, ImportTable], records: list[dict[str, str]],
    actions: dict[str, str], user: CurrentUser, *, include_events: bool = False,
) -> tuple[int, int]:
    if not user.has(PERM_ORDER_EVENT_POST):
        raise PermissionDenied("当前角色无权登记或更新返点")
    rows = sorted(detail_records(tables, records, section="rebates", label="返点明细"),
                  key=lambda item: (item[2].get("订单号", ""), item[2].get("返点单号", "")))
    source_events: dict[str, tuple[str, int, dict[str, str]]] = {}
    if include_events:
        for sheet, row_number, event in detail_records(tables, records, section="events", label="操作明细"):
            if event.get("来源类型", "").strip().upper() != "REBATE":
                continue
            source_id = event.get("来源编号", "").strip().upper()
            if not source_id or source_id in source_events:
                raise Validation("返点事件的来源编号缺失或重复", details={"sheet": sheet, "row": row_number})
            source_events[source_id] = (sheet, row_number, event)
    seen: set[str] = set()
    created = updated = 0
    for sheet, row_number, row in rows:
        order_no = row.get("订单号", "").strip().upper()
        if actions.get(order_no) == "skip":
            continue
        order = session.scalar(select(Order).where(Order.order_no == order_no).with_for_update().execution_options(populate_existing=True))
        if order is None:
            raise Validation("返点的订单不存在或未导入", details={"sheet": sheet, "row": row_number})
        number = row.get("返点单号", "").strip().upper()
        if not re.fullmatch(re.escape(order_no) + r"-RB\d{2,}", number):
            raise Validation("返点单号须与订单号对应", details={"sheet": sheet, "row": row_number})
        if number in seen:
            raise Validation("文件中返点单号重复", details={"sheet": sheet, "row": row_number})
        seen.add(number)
        rebate_type = _TYPE.get(row.get("返点类型", "").strip().upper())
        if rebate_type is None:
            raise Validation("返点类型须为买号返点或卖号返点", details={"sheet": sheet, "row": row_number})
        try:
            amount = to_money(row.get("返点金额") or row.get("金额", ""))
            raw_date = row.get("收到日期", "").strip()
            collected = date.fromisoformat(raw_date) if len(raw_date) == 10 else datetime.fromisoformat(raw_date).date()
        except ValueError as exc:
            raise Validation("返点金额或收到日期无效", details={"sheet": sheet, "row": row_number}) from exc
        code = row.get("资金账户编码", "").strip()
        pool = resolve_pool_code(session, code)
        if code and (pool is None or not user.can_see_pool(pool.id)):
            raise Validation("资金账户不存在或无权使用", details={"sheet": sheet, "row": row_number})
        existing = session.scalar(select(RebateRecord).where(RebateRecord.rebate_no == number))
        note = row.get("备注", "").strip() or None
        channel = row.get("渠道", "").strip() or None
        if existing is not None:
            if existing.source_order_id != order.id or existing.rebate_type != rebate_type or (channel and channel != existing.channel):
                raise Validation("返点单号对应的订单、类型或渠道不一致", details={"sheet": sheet, "row": row_number})
            flows = session.scalars(select(Cashflow).join(OrderEvent, OrderEvent.event_no == Cashflow.source_id).where(
                OrderEvent.order_id == order.id, OrderEvent.source_type == "REBATE", OrderEvent.source_id == number,
                Cashflow.source_type == "ORDER_EVENT",
            )).all()
            if len(flows) != 1 or not user.can_see_pool(flows[0].pool_id) or (pool is not None and pool.id != flows[0].pool_id):
                raise Validation("返点关联资金账户不明确或无权修改", details={"sheet": sheet, "row": row_number})
            changes = {"amount": amount, "collected_on": collected}
            if note is not None:
                changes["note"] = note
            update_rebate(session, existing.id, actor=user.username, user=user, **changes)
            updated += 1
        else:
            if pool is None:
                raise Validation("新返点必须填写资金账户编码", details={"sheet": sheet, "row": row_number})
            event_info = source_events.get(number)
            operators = None
            extra = None
            if event_info is not None:
                event_sheet, event_row, event = event_info
                location = {"sheet": event_sheet, "row": event_row}
                try:
                    extra = json.loads(event.get("运营详情(JSON)") or "{}")
                    if not isinstance(extra, dict):
                        raise ValueError("not an object")
                except (ValueError, TypeError) as exc:
                    raise Validation("返点事件详情格式无效", details=location) from exc
                if extra.pop("rebate_type", rebate_type) != rebate_type:
                    raise Validation("返点事件与返点类型不一致", details=location)
                operators = _operators(session, event.get("操作人", ""), location)
            added = create_rebate(session, source_order_id=order.id, amount=amount, collected_on=collected,
                                  rebate_type=rebate_type, channel=channel, note=note, pool_id=pool.id,
                                  actor=user.username, user=user, operator_user_ids=operators, form_extra=extra)
            if added.rebate_no != number:
                raise Validation("返点单号与当前订单编号顺序不一致", details={"sheet": sheet, "row": row_number})
            created += 1
    return created, updated
