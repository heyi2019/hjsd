"""订单详情中的资金明细编辑。"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import NotFound
from app.core.security import CurrentUser
from app.domain.trade import Cashflow, Order, OrderEvent

from .schemas import ExecutionCashflowEditItem


def apply_cashflow_edits(db: Session, account_id: int, items: list[ExecutionCashflowEditItem], user: CurrentUser) -> None:
    for item in items:
        flow = db.scalar(select(Cashflow).where(Cashflow.flow_no == item.flow_no).with_for_update())
        if flow is None or not user.can_see_pool(flow.pool_id):
            raise NotFound("资金明细不存在")
        order_id = flow.order_id
        if order_id is None and flow.order_event_id is not None:
            order_id = db.scalar(select(OrderEvent.order_id).where(OrderEvent.id == flow.order_event_id))
        if order_id is None or db.scalar(select(Order.id).where(Order.id == order_id, Order.account_id == account_id)) is None:
            raise NotFound("资金明细不存在")
        before = {"note": flow.note, "occurred_at": flow.created_at, "operator": flow.created_by}
        if "note" in item.model_fields_set:
            flow.note = item.note
        if "operator" in item.model_fields_set and item.operator is not None:
            flow.created_by = item.operator.strip()
        if item.occurred_at is not None:
            occurred_at = item.occurred_at.replace(tzinfo=None)
            flow.occurred_on = occurred_at.date()
            flow.created_at = occurred_at
        flow.updated_by = user.username
        record_audit(db, action="ORDER_UPDATE", entity_type="inventory_cashflow_edit", entity_id=flow.flow_no, actor=user.username, before=before, after={"note": flow.note, "occurred_at": flow.created_at, "operator": flow.created_by})
