"""导入订单手工资金明细；来源业务流水须与来源凭证一起处理。"""
from __future__ import annotations

from datetime import date, datetime
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.business.collaboration import create_cashflow
from app.core.errors import PermissionDenied, Validation
from app.core.money import to_money
from app.core.security import CurrentUser, PERM_ORDER_EVENT_POST
from app.domain.enums import AccountingAttribute, SequenceKey
from app.domain.foundation import DocumentSequence
from app.domain.trade import Cashflow, Order, OrderEvent
from app.settings.field_definitions.pools import assert_pool_usable

from .parser import ImportTable, detail_records
from .events import _operators
from .reference_codes import resolve_pool_code

_DIRECTION = {"IN": "IN", "OUT": "OUT", "收入": "IN", "支出": "OUT"}


def import_cashflows(
    session: Session, tables: dict[str, ImportTable], records: list[dict[str, str]],
    actions: dict[str, str], user: CurrentUser, *, deferred_events: set[str] | None = None,
) -> tuple[int, int, list[dict[str, str]]]:
    if not user.has(PERM_ORDER_EVENT_POST):
        raise PermissionDenied("当前角色无权登记订单资金明细")
    deferred_events = deferred_events or set()
    rows = [item for item in detail_records(tables, records, section="cashflows", label="资金明细") if actions.get(item[2].get("订单号", "").strip().upper()) != "skip"]
    order_numbers = sorted({item[2].get("订单号", "").strip().upper() for item in rows})
    orders = {order.order_no: order for order in session.scalars(select(Order).where(
        Order.order_no.in_(order_numbers)
    ).order_by(Order.id).with_for_update().execution_options(populate_existing=True)).all()}
    prepared = []
    seen: set[str] = set()
    for sheet, row_number, row in rows:
        details = {"sheet": sheet, "row": row_number}
        order_no = row.get("订单号", "").strip().upper()
        order = orders.get(order_no)
        if order is None:
            raise Validation("资金明细的订单不存在或未导入", details=details)
        direction = _DIRECTION.get(row.get("方向", "").strip().upper())
        number = row.get("流水号", "").strip().upper()
        prefix = "SR" if direction == "IN" else "ZC"
        if direction is None or not re.fullmatch(prefix + r"(?!00000)\d{5}", number):
            raise Validation("流水号须与收入或支出方向对应", details=details)
        if number in seen:
            raise Validation("文件中流水号重复", details=details)
        seen.add(number)
        source = row.get("来源类型", "").strip().upper()
        source_id = row.get("来源编号", "").strip().upper()
        if (source == "MANUAL" and source_id) or (source == "ORDER_EVENT" and not source_id) or source not in {"MANUAL", "ORDER_EVENT"}:
            raise Validation("关联业务的资金流水须连同来源凭证处理，不能作为手工流水导入", details=details)
        category = row.get("业务类别编码", "").strip().upper()
        if not re.fullmatch(r"[A-Z][A-Z0-9_]{0,31}", category):
            raise Validation("请填写有效的业务类别编码", details=details)
        attribute = row.get("核算属性", "").strip().upper()
        if attribute not in AccountingAttribute.values():
            raise Validation("核算属性无效，请填写系统核算属性编码", details=details)
        try:
            amount = to_money(row.get("金额", ""))
            raw_date = (row.get("时间") or row.get("发生日期") or "").strip()
            occurred = date.fromisoformat(raw_date) if len(raw_date) == 10 else datetime.fromisoformat(raw_date).date()
        except ValueError as exc:
            raise Validation("资金金额或日期无效", details=details) from exc
        if amount < 0 or (amount == 0 and source != "ORDER_EVENT"):
            raise Validation("资金金额必须大于零", details=details)
        code = row.get("资金账户编码", "").strip()
        pool = resolve_pool_code(session, code)
        if pool is None or not user.can_see_pool(pool.id):
            raise Validation("资金账户不存在或无权使用", details=details)
        operators = _operators(session, row.get("操作人", ""), details)
        prepared.append((details, order, pool, number, direction, category, attribute, amount, occurred,
                         row.get("备注", "").strip() or None, source, source_id, operators))

    # 保持订单 → 资金账户 → 编号的锁序，避免与普通资金操作互相等待。
    for pool_id in sorted({item[2].id for item in prepared}):
        assert_pool_usable(session, pool_id)
    existing_by_no = {flow.flow_no: flow for flow in session.scalars(select(Cashflow).where(
        Cashflow.flow_no.in_([item[3] for item in prepared])
    ).with_for_update().execution_options(populate_existing=True)).all()}
    grouped: dict[str, list[int]] = {}
    for _details, _order, _pool, number, direction, _category, _attribute, _amount, _occurred, _note, source, _source_id, _operators_value in prepared:
        if source == "MANUAL" and number not in existing_by_no:
            key = SequenceKey.CASHFLOW_IN.value if direction == "IN" else SequenceKey.CASHFLOW_OUT.value
            grouped.setdefault(key, []).append(int(number[2:]))
    for key in sorted(grouped):
        sequence = session.scalar(select(DocumentSequence).where(DocumentSequence.sequence_key == key).with_for_update().execution_options(populate_existing=True))
        if sequence is None:
            raise Validation("资金流水编号序列未初始化")
        sequence.current_value = max(sequence.current_value, max(grouped[key]))
    session.flush()
    # 发号器和导入持有同一序列锁；等待之后再次确认编号未被并发占用。
    existing_by_no = {flow.flow_no: flow for flow in session.scalars(select(Cashflow).where(
        Cashflow.flow_no.in_([item[3] for item in prepared])
    ).with_for_update().execution_options(populate_existing=True)).all()}
    created = matched = 0
    renumbered: list[dict[str, str]] = []
    claimed: set[int] = set()
    for details, order, pool, number, direction, category, attribute, amount, occurred, note, source, source_id, operators in prepared:
        existing = existing_by_no.get(number)
        if source == "ORDER_EVENT":
            event = session.scalar(select(OrderEvent).where(OrderEvent.order_id == order.id, OrderEvent.event_no == source_id, OrderEvent.is_posted.is_(True)))
            if event is None:
                raise Validation("关联业务事件不存在，请先导入来源事件", details=details)
            if source_id in deferred_events:
                if amount <= 0:
                    raise Validation("拆分资金明细金额必须大于零", details=details)
                added = create_cashflow(session, pool_id=pool.id, occurred_on=occurred, direction=direction,
                                        category=category, accounting_attribute=attribute, amount=amount, order_id=order.id,
                                        source_type=source, source_id=source_id, note=note, actor=user.username,
                                        user=user, form_extra_scope=None, operator_user_ids=operators)
                if added.flow_no != number:
                    renumbered.append({"source": number, "current": added.flow_no})
                claimed.add(added.id)
                created += 1
                continue
            if existing is not None and (existing.order_id != order.id or existing.source_type != source or existing.source_id != source_id):
                raise Validation("流水号与已有记录冲突", details=details)
            candidates = session.scalars(select(Cashflow).where(Cashflow.order_id == order.id,
                Cashflow.source_type == source, Cashflow.source_id == source_id).with_for_update().execution_options(populate_existing=True)).all()
            candidates = [flow for flow in candidates if flow.id not in claimed and user.can_see_pool(flow.pool_id)
                          and flow.pool_id == pool.id and flow.direction == direction and flow.category == category
                          and flow.accounting_attribute == attribute and flow.amount == amount and flow.occurred_on == occurred
                          and (note is None or flow.note == note)
                          and (operators is None or flow.operator_user_ids == operators)]
            exact = next((flow for flow in candidates if flow.flow_no == number), None)
            chosen = exact or (candidates[0] if len(candidates) == 1 else None)
            if chosen is None:
                raise Validation("来源事件与资金明细无法唯一对应，请核对后再导入", details=details)
            claimed.add(chosen.id)
            if chosen.flow_no != number:
                renumbered.append({"source": number, "current": chosen.flow_no})
            matched += 1
            continue
        if existing is not None:
            if (not user.can_see_pool(existing.pool_id) or existing.order_id != order.id or existing.pool_id != pool.id
                    or existing.source_type != "MANUAL" or existing.direction != direction or existing.category != category
                    or existing.accounting_attribute != attribute or existing.amount != amount or existing.occurred_on != occurred
                    or (note is not None and existing.note != note)
                    or (operators is not None and existing.operator_user_ids != operators)):
                raise Validation("已有流水与文件内容不一致，请通过原业务核对", details=details)
            matched += 1
            continue
        create_cashflow(session, pool_id=pool.id, occurred_on=occurred, direction=direction,
                        category=category, accounting_attribute=attribute, amount=amount, order_id=order.id,
                        source_type="MANUAL", note=note, actor=user.username, user=user,
                        form_extra_scope="REFUND", imported_flow_no=number, operator_user_ids=operators)
        created += 1
    return created, matched, renumbered
