"""订单详情中的资金明细编辑。"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser
from app.domain.trade import Cashflow, Order, OrderEvent
from app.domain.users import User

from .schemas import ExecutionCashflowEditItem


def apply_cashflow_edits(db: Session, account_id: int, target_order_id: int, items: list[ExecutionCashflowEditItem], user: CurrentUser) -> None:
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
        flow = db.scalar(select(Cashflow).where(Cashflow.flow_no == item.flow_no).with_for_update())
        if flow is None or not user.can_see_pool(flow.pool_id):
            raise NotFound("资金明细不存在")
        flow_order_id = flow.order_id
        if flow_order_id is None and flow.order_event_id is not None:
            flow_order_id = db.scalar(select(OrderEvent.order_id).where(OrderEvent.id == flow.order_event_id))
        if flow_order_id is None or flow_order_id != target_order_id or db.scalar(select(Order.id).where(Order.id == flow_order_id, Order.account_id == account_id)) is None:
            raise NotFound("资金明细不存在")
        before = {"note": flow.note, "occurred_at": flow.created_at.isoformat() if flow.created_at else None, "operator": flow.created_by, "operator_user_ids": flow.operator_user_ids}
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
        record_audit(db, action="ORDER_UPDATE", entity_type="inventory_cashflow_edit", entity_id=flow.flow_no, actor=user.username, before=before, after={"note": flow.note, "occurred_at": flow.created_at.isoformat() if flow.created_at else None, "operator": flow.created_by, "operator_user_ids": flow.operator_user_ids})
