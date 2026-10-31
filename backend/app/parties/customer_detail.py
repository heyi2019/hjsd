"""parties.customer_detail：客户详情聚合与活动摘要。"""
from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.core.security import CurrentUser, owner_scope_filter
from app.domain.enums import OrderStatus, ScheduleStatus
from app.domain.foundation import AuditLog
from app.domain.parties import OrderCustomerRole
from app.domain.trade import Installment, InstallmentSchedule, Order, OrderEvent

from .customers import get_customer

def get_customer_activity_summary(
    session: Session,
    customer_ids: Sequence[int],
    user: CurrentUser | None = None,
) -> dict[int, dict[str, Any]]:
    """从订单参与关系与事件时间线汇总客户列表的经营摘要。"""
    ids = {customer_id for customer_id in customer_ids if isinstance(customer_id, int)}
    summary = {
        customer_id: {
            "order_roles": [],
            "active_order_count": 0,
            "last_interaction_at": None,
        }
        for customer_id in ids
    }
    if not ids:
        return summary
    order_ids_by_customer: dict[int, set[int]] = {customer_id: set() for customer_id in ids}
    active_order_ids_by_customer: dict[int, set[int]] = {
        customer_id: set() for customer_id in ids
    }
    stmt = select(OrderCustomerRole, Order).join(
        Order, Order.id == OrderCustomerRole.order_id
    ).where(OrderCustomerRole.customer_id.in_(ids))
    scope = owner_scope_filter(Order.owner_id, user, session) if user is not None else None
    if scope is not None:
        stmt = stmt.where(scope)
    rows = session.execute(stmt).all()
    for role_row, order in rows:
        item = summary[role_row.customer_id]
        if role_row.role not in item["order_roles"]:
            item["order_roles"].append(role_row.role)
        order_ids_by_customer[role_row.customer_id].add(order.id)
        if order.status == "ACTIVE":
            active_order_ids_by_customer[role_row.customer_id].add(order.id)
        if order.created_at and (
            item["last_interaction_at"] is None
            or order.created_at > item["last_interaction_at"]
        ):
            item["last_interaction_at"] = order.created_at

    event_stmt = select(OrderCustomerRole.customer_id, OrderEvent.created_at).join(
        OrderEvent, OrderEvent.order_id == OrderCustomerRole.order_id
    ).join(Order, Order.id == OrderCustomerRole.order_id).where(
        OrderCustomerRole.customer_id.in_(ids)
    )
    if scope is not None:
        event_stmt = event_stmt.where(scope)
    event_rows = session.execute(
        event_stmt
    ).all()
    for customer_id, created_at in event_rows:
        if created_at and (
            summary[customer_id]["last_interaction_at"] is None
            or created_at > summary[customer_id]["last_interaction_at"]
        ):
            summary[customer_id]["last_interaction_at"] = created_at
    for item in summary.values():
        item["order_roles"].sort()
    for customer_id, order_ids in active_order_ids_by_customer.items():
        summary[customer_id]["active_order_count"] = len(order_ids)
    return summary


def get_customer_detail(
    session: Session, customer_id: int, user: CurrentUser | None = None
) -> dict[str, Any]:
    """返回客户详情页四个页签所需的聚合数据（CUS-01-03）。

    订单、分期金额和逾期数均从业务事实表实时汇总；这里不保存任何手工汇总值。
    """
    customer = get_customer(session, customer_id, user)
    role_stmt = select(OrderCustomerRole, Order).join(
        Order, Order.id == OrderCustomerRole.order_id
    ).where(OrderCustomerRole.customer_id == customer.id)
    scope = owner_scope_filter(Order.owner_id, user, session) if user is not None else None
    if scope is not None:
        role_stmt = role_stmt.where(scope)
    role_rows = session.execute(
        role_stmt.order_by(Order.trade_date.desc(), Order.id.desc())
    ).all()

    business_by_order: dict[int, dict[str, Any]] = {}
    for role_row, order in role_rows:
        item = business_by_order.setdefault(
            order.id,
            {
                "order_id": order.id,
                "order_no": order.order_no,
                "order_type": order.order_type,
                "capital_type": order.capital_type,
                "status": order.status,
                "trade_date": order.trade_date,
                "owner_id": order.owner_id,
                "roles": [],
            },
        )
        if role_row.role not in item["roles"]:
            item["roles"].append(role_row.role)

    orders = list(business_by_order.values())
    order_ids = list(business_by_order)
    installments = list(
        session.scalars(
            select(Installment)
            .where(Installment.order_id.in_(order_ids))
            .order_by(Installment.id.desc())
        ).all()
    ) if order_ids else []
    installment_ids = [item.id for item in installments]
    schedules = list(
        session.scalars(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id.in_(installment_ids)
            )
        ).all()
    ) if installment_ids else []
    overdue_by_installment: dict[int, int] = {}
    for schedule in schedules:
        if schedule.status == ScheduleStatus.OVERDUE.value:
            overdue_by_installment[schedule.installment_id] = (
                overdue_by_installment.get(schedule.installment_id, 0) + 1
            )

    order_no_by_id = {item["order_id"]: item["order_no"] for item in orders}
    installment_items: list[dict[str, Any]] = []
    paid_total = Decimal("0.00")
    receivable_total = Decimal("0.00")
    overdue_period_count = 0
    for item in installments:
        receivable = (
            to_money(item.down_payment)
            + to_money(item.per_period) * int(item.periods)
            + to_money(item.final_period_adjustment or 0)
            - to_money(item.waived_amount)
        )
        paid = to_money(item.paid_amount)
        remaining = receivable - paid
        overdue_periods = overdue_by_installment.get(item.id, 0)
        paid_total += paid
        receivable_total += receivable
        overdue_period_count += overdue_periods
        installment_items.append(
            {
                "id": item.id,
                "inst_no": item.inst_no,
                "order_id": item.order_id,
                "order_no": order_no_by_id.get(item.order_id),
                "contract_type": item.contract_type,
                "status": item.status,
                "principal": to_money(item.principal),
                "total_receivable": receivable,
                "paid_amount": paid,
                "remaining_amount": remaining,
                "overdue_periods": overdue_periods,
                "first_due_on": item.first_due_on,
            }
        )

    audit_rows = session.scalars(
        select(AuditLog)
        .where(
            AuditLog.entity_type == "customer",
            AuditLog.entity_id == customer.customer_no,
        )
        .order_by(AuditLog.id.desc())
        .limit(100)
    ).all()
    audit_items = [
        {
            "id": row.id,
            "action": row.action,
            "entity_type": row.entity_type,
            "entity_id": row.entity_id,
            "actor": row.actor,
            "before": row.before_json,
            "after": row.after_json,
            "reason": row.reason,
            "request_id": row.request_id,
            "occurred_at": row.occurred_at,
        }
        for row in audit_rows
    ]
    last_trade_date = max(
        (item["trade_date"] for item in orders), default=None
    )
    return {
        "overview": {
            "order_count": len(orders),
            "active_order_count": sum(
                item["status"] == OrderStatus.ACTIVE.value for item in orders
            ),
            "completed_order_count": sum(
                item["status"] == OrderStatus.COMPLETED.value for item in orders
            ),
            "cancelled_order_count": sum(
                item["status"] == OrderStatus.CANCELLED.value for item in orders
            ),
            "last_trade_date": last_trade_date,
            "installment_paid_total": paid_total,
            "installment_receivable_total": receivable_total,
            "installment_remaining_total": receivable_total - paid_total,
            "overdue_period_count": overdue_period_count,
        },
        "business": orders,
        "installments": installment_items,
        "audit": audit_items,
    }
