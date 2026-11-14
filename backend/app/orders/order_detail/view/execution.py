"""订单详情执行视图的读取与装配。"""
from __future__ import annotations

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.security import CurrentUser, PERM_AUDIT_READ
from app.domain.foundation import AuditLog
from app.orders._shared import get_order
from app.stocks.profile import get_account
from app.stocks.router_output import _account_outputs
from .execution_schemas import AccountAuditOut, AccountExecutionDetailOut

from .assembler import build_order_outputs
from .derived import build_detail_view
from .events import load_event_context
from .finance import build_finance_summary
from .relations import load_relations


def load_order_execution_detail(
    db: Session, order_id: int, user: CurrentUser
) -> AccountExecutionDetailOut:
    """读取一个订单及其强绑定账号的全部详情数据。"""
    order = get_order(db, order_id, user)
    if order.account_id is None:
        from app.core.errors import NotFound
        raise NotFound("订单未关联库存账号")
    account = get_account(db, order.account_id, user)
    # get_order 已完成当前用户的 owner scope 校验；订单与账号是一一绑定关系，
    # 这里直接复用已加载的订单，避免为同一详情重复查订单。
    orders = [order]
    relations = load_relations(db, orders)
    context = load_event_context(db, [order.id])
    events = context.events_by_order
    event_ids = [event.id for rows in events.values() for event in rows]
    audit: list[AccountAuditOut] = []
    if user.has(PERM_AUDIT_READ):
        filters = [(AuditLog.entity_type == "account") & (AuditLog.entity_id == str(account.id))]
        filters.append((AuditLog.entity_type == "order") & (AuditLog.entity_id == order.order_no))
        if event_ids:
            event_id_values = [str(item) for item in event_ids]
            filters.append((AuditLog.entity_type == "inventory_event_edit") & AuditLog.entity_id.in_(event_id_values))
        filters.append((AuditLog.entity_type == "inventory_order_edit") & (AuditLog.entity_id == str(order.id)))
        flow_nos = [flow.flow_no for flow in context.order_cashflows.get(order.id, [])]
        if flow_nos:
            filters.append((AuditLog.entity_type == "inventory_cashflow_edit") & AuditLog.entity_id.in_(flow_nos))
        audit = [AccountAuditOut(id=row.id, action=row.action, entity_type=row.entity_type, entity_id=row.entity_id, actor=row.actor, reason=row.reason, occurred_at=row.occurred_at) for row in db.scalars(select(AuditLog).where(or_(*filters)).order_by(AuditLog.occurred_at.desc(), AuditLog.id.desc())).all()]
    outputs = build_order_outputs(
        orders,
        order_extra_values=relations.order_extra_values,
        field_defs_by_type=relations.field_defs_by_type,
        cashflows_by_order=context.order_cashflows,
        customers_by_order=relations.customers_by_order,
        counterparties_by_order=relations.counterparties_by_order,
        rebates_by_order=relations.rebates_by_order,
        events_by_order=events,
    )
    return AccountExecutionDetailOut(
        account=_account_outputs(db, [account], user)[0],
        finance_summary=build_finance_summary(db, order_ids=[order.id], event_cashflows=context.event_cashflows, order_cashflows=context.order_cashflows, order_rebates=relations.rebates_by_order, action_model_rebate_ids=context.action_model_rebate_ids, deposit_loss_flow_nos=context.deposit_loss_flow_nos),
        orders=outputs,
        detail_view=build_detail_view(
            outputs,
            account_description=account.account_description,
            account_images=account.account_images or [],
        ),
        audit=audit,
    )
