"""订单详情中的执行事件编辑。"""
from __future__ import annotations

from decimal import Decimal

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Conflict, NotFound, Validation
from app.core.security import CurrentUser
from app.domain.trade import Account, Cashflow, Installment, OrderEvent, RebateRecord, Reconciliation
from app.domain.users import User
from app.orders._shared import get_order

from .schemas import ExecutionEditItem, ExecutionEditRequest


def validate_event_edits(
    db: Session,
    account: Account,
    order_id: int,
    payload: ExecutionEditRequest,
    user: CurrentUser,
) -> tuple[list[tuple[OrderEvent, Cashflow | None, ExecutionEditItem]], Decimal]:
    changes: list[tuple[OrderEvent, Cashflow | None, ExecutionEditItem]] = []
    cost_delta = Decimal("0")
    requested_operator_ids = {
        operator_id
        for item in payload.events
        for operator_id in (item.operator_user_ids or [])
    }
    active_operator_ids = set(db.scalars(
        select(User.id).where(User.id.in_(requested_operator_ids), User.is_active.is_(True))
    ).all()) if requested_operator_ids else set()
    for item in payload.events:
        event = db.scalar(select(OrderEvent).where(OrderEvent.id == item.id).with_for_update())
        order = get_order(db, event.order_id, user) if event else None
        if event is None or order is None or order.id != order_id or order.account_id != account.id or not event.is_posted:
            raise NotFound("执行记录不存在")
        if Decimal(str(event.amount)) != item.expected_amount:
            raise Conflict("执行记录已被修改，请刷新后重试")
        if item.operator_user_ids is not None:
            ids = item.operator_user_ids
            if len(set(ids)) != len(ids):
                raise Validation("操作人不能重复选择")
            if not set(ids).issubset(active_operator_ids):
                raise Validation("所选操作人不存在或已停用")
        flow = db.scalar(select(Cashflow).where(Cashflow.order_event_id == event.id).with_for_update())
        if flow is not None and not user.can_see_pool(flow.pool_id):
            raise NotFound("关联资金流水不存在")
        if item.amount == Decimal(str(event.amount)):
            changes.append((event, flow, item))
            continue
        if event.event_type not in {"BUY", "SELL"} or item.amount <= 0:
            raise Validation("该类型执行记录暂不支持修改金额")
        if flow is None:
            raise NotFound("关联资金流水不存在")
        if Decimal(str(flow.amount)) != Decimal(str(event.amount)):
            raise Validation("执行记录与关联流水金额不一致，请先核对")
        if (
            event.offset_event_id is not None
            or flow.reversal_of_id is not None
            or db.scalar(select(OrderEvent.id).where(OrderEvent.offset_event_id == event.id)) is not None
            or db.scalar(select(Cashflow.id).where(Cashflow.reversal_of_id == flow.id)) is not None
        ):
            raise Validation("已冲销或被冲销的记录不能直接修改")
        if db.scalar(select(Installment.id).where(Installment.order_id == order.id)) is not None:
            raise Validation("关联分期的记录不能直接修改，请先处理分期")
        if db.scalar(select(RebateRecord.id).where(RebateRecord.source_order_id == order.id)) is not None:
            raise Validation("关联返点的记录不能直接修改，请先核对返点")
        if db.scalar(select(Reconciliation.id).where(Reconciliation.pool_id == flow.pool_id, Reconciliation.reconciled_on >= flow.occurred_on)) is not None:
            raise Validation("资金池已有后续对账记录，不能直接修改")
        if event.event_type == "BUY":
            cost_delta += item.amount - Decimal(str(event.amount))
        changes.append((event, flow, item))
    if Decimal(str(account.cost_amount)) + cost_delta < 0:
        raise Validation("修改后库存成本不能为负数")
    return changes, cost_delta


def apply_event_edits(db: Session, changes: list[tuple[OrderEvent, Cashflow | None, ExecutionEditItem]], actor: str) -> None:
    for event, flow, item in changes:
        occurred_at = event.posted_at or event.created_at
        before = {
            "amount": str(event.amount),
            "note": event.note,
            "occurred_at": occurred_at.isoformat() if occurred_at else None,
            "operator_user_ids": event.operator_user_ids,
            "form_extra": jsonable_encoder(event.form_extra),
            "flow_amount": str(flow.amount) if flow else None,
            "flow_note": flow.note if flow else None,
        }
        amount_changed = item.amount != Decimal(str(event.amount))
        event.amount = item.amount
        if "note" in item.model_fields_set:
            event.note = item.note
        if item.occurred_at is not None:
            occurred_at = item.occurred_at.replace(tzinfo=None)
            event.occurred_on = occurred_at.date()
            event.posted_at = occurred_at
            operation_type = (event.form_extra or {}).get("operation_type")
            if event.event_type == "OPERATE" and operation_type == "CONSIGNMENT":
                event.form_extra = {**(event.form_extra or {}), "listed_at": occurred_at.isoformat()}
            elif event.event_type == "OPERATE" and operation_type == "UNLIST":
                event.form_extra = {**(event.form_extra or {}), "platform_unlisted_at": occurred_at.isoformat()}
            if flow is not None:
                flow.occurred_on = occurred_at.date()
                flow.created_at = occurred_at
        if item.form_extra is not None:
            # 前端提交的是该事件当前完整草稿；使用替换才能真正删除已清空的平台、价格等字段。
            event.form_extra = item.form_extra
        if item.operator_user_ids is not None:
            event.operator_user_ids = item.operator_user_ids
        event.updated_by = actor
        if flow is not None and amount_changed:
            flow.amount = item.amount
            flow.updated_by = actor
        record_audit(
            db,
            action="ORDER_UPDATE",
            entity_type="inventory_event_edit",
            entity_id=event.id,
            actor=actor,
            before=before,
            after={
                "amount": str(item.amount),
                "note": event.note,
                "occurred_at": (event.posted_at or event.created_at).isoformat()
                if event.posted_at or event.created_at
                else None,
                "operator_user_ids": event.operator_user_ids,
                "form_extra": jsonable_encoder(event.form_extra),
                "flow_amount": str(flow.amount) if flow else None,
                "flow_note": flow.note if flow else None,
            },
        )
