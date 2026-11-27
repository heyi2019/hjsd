"""订单详情中的资金明细编辑。"""
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser
from app.domain.trade import Cashflow, Order, OrderEvent
from app.domain.enums import CashflowSourceType
from app.domain.foundation import Pool
from app.domain.users import User
from app.settings.field_definitions.pools import assert_pool_usable

from ..timestamps import business_timestamp
from .schemas import ExecutionCashflowEditItem, ExecutionEditItem, ExecutionEditRequest


def prepare_cashflow_event_edits(db: Session, order_id: int, payload: ExecutionEditRequest, user: CurrentUser) -> ExecutionEditRequest:
    """关联事件的金额和日期统一走事件编辑，保留库存与资金的勾稽。"""
    candidates = [item for item in payload.cashflows if item.amount is not None or item.occurred_at is not None]
    if not candidates:
        return payload
    rows = db.execute(select(Cashflow, OrderEvent).join(
        OrderEvent, and_(Cashflow.source_type == CashflowSourceType.ORDER_EVENT.value,
                         Cashflow.source_id == OrderEvent.event_no),
    ).where(Cashflow.flow_no.in_([item.flow_no for item in candidates]), OrderEvent.order_id == order_id)).all()
    by_flow = {flow.flow_no: (flow, event) for flow, event in rows}
    events = list(payload.events)
    by_event = {item.id: item for item in events}
    for item in candidates:
        pair = by_flow.get(item.flow_no)
        if pair is None:
            continue
        flow, event = pair
        if not user.can_see_pool(flow.pool_id):
            raise NotFound("资金明细不存在")
        amount_changed = item.amount is not None and item.amount != flow.amount
        time_changed = item.occurred_at is not None and item.occurred_at.replace(tzinfo=None) != business_timestamp(flow.occurred_on, flow.created_at)
        if not amount_changed and not time_changed:
            continue
        if amount_changed and event.event_type not in {"BUY", "SELL"}:
            raise Validation("关联业务的金额请通过原业务修改", details={"flow_no": flow.flow_no})
        if amount_changed and flow.amount != event.amount:
            raise Validation("执行记录与关联流水金额不一致，请先核对")
        if time_changed and event.event_type not in {"BUY", "SELL", "REBATE"}:
            raise Validation("关联业务的日期请通过原业务修改", details={"flow_no": flow.flow_no})
        edit = by_event.get(event.id)
        if edit is None:
            edit = ExecutionEditItem(id=event.id, expected_amount=event.amount, amount=event.amount)
            events.append(edit)
            by_event[event.id] = edit
        changes = {}
        if amount_changed:
            if edit.amount != edit.expected_amount and edit.amount != item.amount:
                raise Validation("执行记录与资金明细的修改金额不一致")
            changes["amount"] = item.amount
        if time_changed:
            if edit.occurred_at is not None and edit.occurred_at != item.occurred_at:
                raise Validation("执行记录与资金明细的修改时间不一致")
            changes["occurred_at"] = item.occurred_at
        if changes:
            updated = edit.model_copy(update=changes)
            events[events.index(edit)] = updated
            by_event[event.id] = updated
    return payload.model_copy(update={"events": events})


def lock_edit_pools(db: Session, order_id: int, payload: ExecutionEditRequest, user: CurrentUser) -> None:
    """按账户编号取得与对账相同的锁，再锁事件及流水。"""
    event_ids = [item.id for item in payload.events if item.occurred_at is not None or item.amount != item.expected_amount]
    flow_items = [item for item in payload.cashflows if item.amount is not None or item.occurred_at is not None or item.pool_id is not None]
    if not event_ids and not flow_items:
        return
    event_nos = select(OrderEvent.event_no).where(OrderEvent.order_id == order_id, OrderEvent.id.in_(event_ids))
    event_flow = and_(Cashflow.source_type == CashflowSourceType.ORDER_EVENT.value, Cashflow.source_id.in_(event_nos))
    named_flow = and_(Cashflow.order_id == order_id, Cashflow.flow_no.in_([item.flow_no for item in flow_items]))
    pool_ids = set(db.scalars(select(Cashflow.pool_id).where(or_(event_flow, named_flow))).all())
    if any(not user.can_see_pool(pool_id) for pool_id in pool_ids):
        raise NotFound("关联资金流水不存在")
    target_pool_ids = set()
    for item in flow_items:
        if item.pool_id is not None:
            if not user.can_see_pool(item.pool_id):
                raise NotFound("资金账户不存在", details={"pool_id": item.pool_id})
            pool_ids.add(item.pool_id)
            target_pool_ids.add(item.pool_id)
    # 先取得状态共享锁，再取得对账使用的账户行锁；与停用操作保持相同顺序。
    for pool_id in sorted(target_pool_ids):
        assert_pool_usable(db, pool_id)
    if pool_ids:
        db.scalars(select(Pool.id).where(Pool.id.in_(pool_ids)).order_by(Pool.id).with_for_update(key_share=True)).all()


def apply_cashflow_edits(db: Session, account_id: int, target_order: Order, items: list[ExecutionCashflowEditItem], user: CurrentUser) -> None:
    requested_operator_ids = {
        operator_id
        for item in items
        for operator_id in (item.operator_user_ids or [])
        if item.operator_user_ids is not None
    }
    active_operator_ids = set(db.scalars(
        select(User.id).where(User.id.in_(requested_operator_ids), User.is_active.is_(True))
    ).all()) if requested_operator_ids else set()
    for item in items:
        flow = db.scalar(select(Cashflow).where(Cashflow.flow_no == item.flow_no).with_for_update().execution_options(populate_existing=True))
        if flow is None or not user.can_see_pool(flow.pool_id):
            raise NotFound("资金明细不存在")
        # 编排入口已锁定目标订单与账号，复用该事务中的订单，不逐条重新查询。
        if flow.order_id != target_order.id or target_order.account_id != account_id:
            raise NotFound("资金明细不存在")
        if item.expected is not None:
            from ..timestamps import business_timestamp
            from .expected import check_expected
            check_expected(item.expected, {"amount": flow.amount, "pool_id": flow.pool_id,
                           "note": flow.note or "", "occurred_at": business_timestamp(flow.occurred_on, flow.created_at),
                           "operator_user_ids": flow.operator_user_ids or []}, "资金明细")
        amount_changed = item.amount is not None and item.amount != flow.amount
        pool_changed = item.pool_id is not None and item.pool_id != flow.pool_id
        date_changed = item.occurred_at is not None and item.occurred_at.date() != flow.occurred_on
        if amount_changed or pool_changed or date_changed:
            if flow.source_type == CashflowSourceType.REVERSAL.value or db.scalar(select(Cashflow.id).where(
                Cashflow.source_type == CashflowSourceType.REVERSAL.value,
                Cashflow.source_id == flow.flow_no,
            )) is not None:
                raise Validation("已冲销或冲销流水不能直接修改", details={"flow_no": flow.flow_no})
            if (amount_changed or date_changed) and flow.source_type != CashflowSourceType.MANUAL.value:
                raise Validation("关联业务的金额或日期请通过原业务修改", details={"flow_no": flow.flow_no})
            if pool_changed and flow.source_type in {CashflowSourceType.DEPOSIT.value, CashflowSourceType.TRANSFER.value}:
                raise Validation("押金或划转资金账户请通过原业务修改", details={"flow_no": flow.flow_no})
        before = {
            "pool_id": flow.pool_id,
            "amount": str(flow.amount),
            "note": flow.note,
            "occurred_at": flow.created_at.isoformat() if flow.created_at else None,
            "operator": flow.created_by,
            "operator_user_ids": flow.operator_user_ids,
        }
        if "pool_id" in item.model_fields_set and item.pool_id is not None:
            if not user.can_see_pool(item.pool_id):
                raise NotFound("资金账户不存在", details={"pool_id": item.pool_id})
            flow.pool_id = assert_pool_usable(db, item.pool_id).id
        if "amount" in item.model_fields_set and item.amount is not None:
            flow.amount = item.amount
        if "note" in item.model_fields_set:
            flow.note = item.note
        if "operator" in item.model_fields_set:
            flow.created_by = item.operator.strip() if item.operator else ""
        if "operator_user_ids" in item.model_fields_set:
            ids = item.operator_user_ids or []
            if len(set(ids)) != len(ids):
                raise Validation("操作人不能重复选择", details={"field": "operator_user_ids"})
            if not set(ids).issubset(active_operator_ids):
                raise Validation("所选操作人不存在或已停用", details={"field": "operator_user_ids"})
            flow.operator_user_ids = ids
        if item.occurred_at is not None:
            occurred_at = item.occurred_at.replace(tzinfo=None)
            flow.occurred_on = occurred_at.date()
            flow.created_at = occurred_at
        flow.updated_by = user.username
        record_audit(
            db,
            action="ORDER_UPDATE",
            entity_type="inventory_cashflow_edit",
            entity_id=flow.flow_no,
            actor=user.username,
            before=before,
            after={
                "pool_id": flow.pool_id,
                "amount": str(flow.amount),
                "note": flow.note,
                "occurred_at": flow.created_at.isoformat() if flow.created_at else None,
                "operator": flow.created_by,
                "operator_user_ids": flow.operator_user_ids,
            },
        )
