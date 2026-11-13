"""订单详情的参与方、返点和扩展字段查询。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.parties import Customer, Counterparty, OrderCounterpartyRole, OrderCustomerRole
from app.domain.trade import Order, OrderFormField, RebateRecord

from ..schemas import ExecutionCounterpartyOut, ExecutionCustomerOut, ExecutionRebateOut


@dataclass(frozen=True)
class DetailRelations:
    order_extra_values: dict[int, dict[str, object]]
    field_defs_by_type: dict[str, dict[str, Any]]
    customers_by_order: dict[int, list[ExecutionCustomerOut]]
    counterparties_by_order: dict[int, list[ExecutionCounterpartyOut]]
    rebates_by_order: dict[int, list[ExecutionRebateOut]]


def load_relations(db: Session, orders: list[Order]) -> DetailRelations:
    order_ids = [order.id for order in orders]
    order_extra_values = {order.id: dict(order.form_extra or {}) for order in orders}
    field_defs = list(db.scalars(
        select(OrderFormField).where(
            OrderFormField.order_type_code.in_({order.order_type for order in orders}),
            OrderFormField.is_active.is_(True),
        )
    ).all()) if orders else []
    field_defs_by_type: dict[str, dict[str, Any]] = {}
    for definition in field_defs:
        field_defs_by_type.setdefault(definition.order_type_code, {})[definition.field_key] = definition

    customers_by_order: dict[int, list[ExecutionCustomerOut]] = {}
    counterparties_by_order: dict[int, list[ExecutionCounterpartyOut]] = {}
    rebates_by_order: dict[int, list[ExecutionRebateOut]] = {}
    if not order_ids:
        return DetailRelations(order_extra_values, field_defs_by_type, customers_by_order, counterparties_by_order, rebates_by_order)

    for role, customer in db.execute(
        select(OrderCustomerRole, Customer)
        .join(Customer, Customer.id == OrderCustomerRole.customer_id)
        .where(OrderCustomerRole.order_id.in_(order_ids))
        .order_by(OrderCustomerRole.id)
    ).all():
        customers_by_order.setdefault(role.order_id, []).append(
            ExecutionCustomerOut(id=customer.id, display_name=customer.display_name, role=role.role)
        )
    for role, counterparty in db.execute(
        select(OrderCounterpartyRole, Counterparty)
        .join(Counterparty, Counterparty.id == OrderCounterpartyRole.counterparty_id)
        .where(OrderCounterpartyRole.order_id.in_(order_ids))
        .order_by(OrderCounterpartyRole.id)
    ).all():
        counterparties_by_order.setdefault(role.order_id, []).append(
            ExecutionCounterpartyOut(id=counterparty.id, display_name=counterparty.display_name, role=role.role)
        )
    for rebate in db.scalars(
        select(RebateRecord)
        .where(RebateRecord.source_order_id.in_(order_ids))
        .order_by(RebateRecord.id)
    ).all():
        rebates_by_order.setdefault(rebate.source_order_id, []).append(
            ExecutionRebateOut(
                id=rebate.id,
                rebate_no=rebate.rebate_no,
                rebate_type=rebate.rebate_type,
                channel=rebate.channel,
                rate=rebate.rate,
                base_amount=rebate.base_amount,
                status=rebate.status,
                collected_on=rebate.collected_on,
                collected_at=rebate.created_at,
            )
        )
    return DetailRelations(order_extra_values, field_defs_by_type, customers_by_order, counterparties_by_order, rebates_by_order)
