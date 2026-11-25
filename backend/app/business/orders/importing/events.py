"""导入运营事件，按稳定事件号恢复平台下架的来源关联。"""
from __future__ import annotations

from datetime import date, datetime
import json
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.business.orders.events import post_event
from app.business.shared.operations.consignment import post_consignment_operation
from app.core.errors import PermissionDenied, Validation
from app.core.money import to_money
from app.core.security import CurrentUser, PERM_ORDER_EVENT_POST
from app.domain.trade import Order, OrderEvent
from app.domain.users import User
from app.shared.user_identity import user_id_for_actor

from .parser import ImportTable, detail_records
from .reference_codes import resolve_pool_code

_OPERATION = {"CONSIGNMENT": "CONSIGNMENT", "寄售": "CONSIGNMENT", "UNLIST": "UNLIST", "下架": "UNLIST",
              "IMAGE": "IMAGE", "更新图片": "IMAGE", "DESCRIPTION": "DESCRIPTION", "更新描述": "DESCRIPTION"}
_EVENT = {"OPERATE": "OPERATE", "运营": "OPERATE", "BUY": "BUY", "买入": "BUY", "SELL": "SELL", "售出": "SELL", "CANCEL": "CANCEL", "取消": "CANCEL", "DELIVER": "DELIVER", "交付": "DELIVER", "REBATE": "REBATE", "返点": "REBATE"}
_PORTION = {"PRINCIPAL": "PRINCIPAL", "本金": "PRINCIPAL", "PROFIT": "PROFIT", "利润": "PROFIT", "GROSS": "GROSS", "总额": "GROSS"}


def _operators(session: Session, raw: str, details: dict) -> list[int] | None:
    name = raw.strip()
    if not name or name in {"-", "—"}:
        return None
    users = session.scalars(select(User).where(User.is_active.is_(True))).all()
    def matches(value: str) -> set[int]:
        ids = {user.id for user in users if user.username == value or user.display_name == value}
        actor_id = user_id_for_actor(session, value, active_only=True)
        if actor_id is not None:
            ids.add(actor_id)
        return ids
    full = matches(name)
    parts = [name] if len(full) == 1 else [part.strip() for part in re.split(r"[、,，]", name) if part.strip()]
    result = []
    for part in parts:
        ids = matches(part)
        if len(ids) != 1:
            raise Validation("操作人无法唯一匹配在职员工", details=details)
        result.append(next(iter(ids)))
    if len(result) != len(set(result)):
        raise Validation("操作人不能重复", details=details)
    return result or None


def import_events(
    session: Session, tables: dict[str, ImportTable], records: list[dict[str, str]],
    actions: dict[str, str], user: CurrentUser, *, include_cashflows: bool = False,
) -> tuple[int, int, set[str]]:
    if not user.has(PERM_ORDER_EVENT_POST):
        raise PermissionDenied("当前角色无权登记订单操作")
    rows = [item for item in detail_records(tables, records, section="events", label="操作明细")
            if actions.get(item[2].get("订单号", "").strip().upper()) != "skip"]
    supplied_flow_events = set()
    if include_cashflows:
        supplied_flow_events = {row.get("来源编号", "").strip().upper()
                                for _, _, row in detail_records(tables, records, section="cashflows", label="资金明细")
                                if row.get("来源类型", "").strip().upper() == "ORDER_EVENT"}
    for sheet, row_number, row in rows:
        sequence = row.get("事件顺序", "").strip()
        if sequence and not sequence.isdigit():
            raise Validation("事件顺序须为非负整数", details={"sheet": sheet, "row": row_number})
    rows.sort(key=lambda item: (item[2].get("订单号", "").strip().upper(),
                                int(item[2].get("事件顺序", "").strip() or item[1])))
    order_numbers = {row.get("订单号", "").strip().upper() for _, _, row in rows}
    orders = {order.order_no: order for order in session.scalars(select(Order).where(
        Order.order_no.in_(order_numbers)
    ).order_by(Order.id).with_for_update().execution_options(populate_existing=True)).all()}
    seen: set[str] = set()
    deferred: set[str] = set()
    created = matched = 0
    for sheet, row_number, row in rows:
        details = {"sheet": sheet, "row": row_number}
        order_no = row.get("订单号", "").strip().upper()
        order = orders.get(order_no)
        if order is None:
            raise Validation("操作明细的订单不存在或未导入", details=details)
        event_type = _EVENT.get(row.get("动作", "").strip().upper())
        if event_type is None:
            raise Validation("该操作类型须与对应来源凭证一起处理", details=details)
        operation_type = _OPERATION.get(row.get("运营动作", "").strip().upper()) if event_type == "OPERATE" else None
        if event_type == "OPERATE" and operation_type is None:
            raise Validation("请填写有效的运营动作", details=details)
        event_no = row.get("事件号", "").strip().upper()
        if not re.fullmatch(re.escape(order_no) + rf"-EV-{event_type}-\d{{2,}}", event_no):
            raise Validation("事件号须与订单号和动作对应", details=details)
        if event_no in seen:
            raise Validation("文件中事件号重复", details=details)
        seen.add(event_no)
        try:
            amount = to_money(row.get("金额", "") or "0")
            raw_date = (row.get("动作时间") or row.get("发生日期") or "").strip()
            occurred = date.fromisoformat(raw_date) if len(raw_date) == 10 else datetime.fromisoformat(raw_date).date()
            extra = json.loads(row.get("运营详情(JSON)") or "{}")
            if not isinstance(extra, dict):
                raise ValueError("not an object")
        except (TypeError, ValueError) as exc:
            raise Validation("运营金额、时间或详情格式无效", details=details) from exc
        if event_type == "OPERATE" and amount != 0:
            raise Validation("运营事件金额必须为零，请核对来源资料", details=details)
        if event_type == "DELIVER" and amount != 0:
            raise Validation("交付事件金额必须为零", details=details)
        posted = row.get("已过账", "").strip().upper()
        if posted and posted not in {"是", "TRUE", "1"}:
            raise Validation("未过账事件不能作为已确认业务导入", details=details)
        pool = None
        portion = None
        sale_mode = None
        offset = None
        if event_type in {"BUY", "SELL", "CANCEL"}:
            portion = _PORTION.get(row.get("金额归属", "").strip().upper())
            if portion is None:
                raise Validation("资金事件须填写金额归属", details=details)
            code = row.get("资金账户编码", "").strip()
            pool = resolve_pool_code(session, code)
            if pool is None or not user.can_see_pool(pool.id):
                raise Validation("资金账户不存在或无权使用", details=details)
            if event_type == "SELL":
                mode = row.get("结算方式", "").strip().upper()
                if mode not in {"", "FULL", "全款"}:
                    raise Validation("分期售出须与分期合约一起导入", details=details)
                sale_mode = "FULL"
            if event_type == "CANCEL":
                offset_no = row.get("冲销来源事件号", "").strip().upper()
                offset = session.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_no == offset_no))
                if offset is None:
                    raise Validation("冲销来源事件不存在，请先导入原事件", details=details)
        parent_no = row.get("关联上架事件号", "").strip().upper()
        if parent_no:
            parent = session.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_no == parent_no))
            if parent is None or (parent.form_extra or {}).get("operation_type") != "CONSIGNMENT":
                raise Validation("关联上架事件不存在或不属于本订单", details=details)
            extra["consignment_event_id"] = parent.id
        elif extra.get("consignment_event_id") is not None:
            raise Validation("下架资料缺少可核对的关联上架事件号", details=details)
        if operation_type == "UNLIST" and extra.get("platform_unlist_scope") == "SYSTEM":
            raise Validation("系统下架须与订单状态及库存来源一同处理", details=details)
        operators = _operators(session, row.get("操作人", ""), details)
        delivery_direction = None
        if event_type == "DELIVER":
            direction = row.get("交付方向", "").strip().upper() or str(extra.get("delivery_direction") or "").upper()
            delivery_direction = {"BUY": "BUY", "买入": "BUY", "买号": "BUY", "SELL": "SELL", "售出": "SELL", "卖号": "SELL"}.get(direction)
            if not delivery_direction or (extra.get("delivery_direction") and extra["delivery_direction"] != delivery_direction):
                raise Validation("交付方向与详情不一致或未填写", details=details)
            if operators is not None:
                raise Validation("交付事件的操作人资料不能安全恢复，请核对来源", details=details)
        note = row.get("备注", "").strip() or None
        reason = row.get("原因", "").strip() or None
        existing = session.scalar(select(OrderEvent).where(OrderEvent.event_no == event_no))
        expected_extra = {**extra}
        if operation_type is not None:
            expected_extra["operation_type"] = operation_type
        if sale_mode is not None:
            expected_extra["sale_mode"] = sale_mode
        if delivery_direction is not None:
            expected_extra["delivery_direction"] = delivery_direction
        if existing is not None:
            if (existing.order_id != order.id or existing.event_type != event_type or not existing.is_posted
                    or existing.occurred_on != occurred or to_money(existing.amount) != amount
                    or (existing.form_extra or {}) != expected_extra or (note is not None and existing.note != note)
                    or (reason is not None and existing.reason != reason)
                    or (offset is not None and existing.offset_event_id != offset.id)
                    or (pool is not None and existing.pool_id != pool.id) or (portion is not None and existing.portion != portion)
                    or (operators is not None and existing.operator_user_ids != operators)):
                raise Validation("已有事件与文件内容不一致，请通过订单详情核对", details=details)
            if event_type == "REBATE" and (row.get("来源类型", "").strip().upper() != "REBATE"
                    or row.get("来源编号", "").strip().upper() != existing.source_id):
                raise Validation("返点事件与来源返点单不一致", details=details)
            matched += 1
            continue
        if event_type == "REBATE":
            raise Validation("返点事件须连同来源返点明细导入", details=details)
        kwargs = {"occurred_on": occurred, "actor": user.username, "note": note, "reason": reason,
                  "operator_user_ids": operators, "form_extra": extra, "user": user}
        if operation_type in {"CONSIGNMENT", "UNLIST"}:
            added, _ = post_consignment_operation(session, order.id, operation_type=operation_type, **kwargs)
        elif event_type == "DELIVER":
            added, _ = post_event(session, order.id, event_type=event_type, delivery_direction=delivery_direction,
                                  bound_phone=extra.get("bound_phone"), bound_phone_owner=extra.get("bound_phone_owner"), **kwargs)
        elif event_type in {"BUY", "SELL", "CANCEL"}:
            defer_flow = event_no in supplied_flow_events and amount > 0
            added, _ = post_event(session, order.id, event_type=event_type, amount=amount,
                                  portion=portion, pool_id=pool.id, sale_mode=sale_mode,
                                  offset_event_id=offset.id if offset is not None else None,
                                  historical_import=True, historical_cashflows_supplied=defer_flow, **kwargs)
            if defer_flow:
                deferred.add(event_no)
        else:
            added, _ = post_event(session, order.id, event_type="OPERATE", operation_type=operation_type, **kwargs)
        if added.event_no != event_no:
            raise Validation("事件号与当前订单编号顺序不一致", details=details)
        created += 1
    return created, matched, deferred
