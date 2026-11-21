"""订单参与方角色构造与追加写入（客户 / 合作方）。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import CurrentUser
from app.shared.order_access import get_order
from app.customers.counterparties import assert_counterparty_usable
from app.customers.customer_merge import assert_customer_usable
from app.domain.trade import Order
from app.business.orders._shared import _validate_participant_roles

def _customer_role(order_id: int, customer_id: int, role: str):
    from app.domain.parties import OrderCustomerRole

    return OrderCustomerRole(order_id=order_id, customer_id=customer_id, role=role)


def _counterparty_role(order_id: int, counterparty_id: int, role: str):
    from app.domain.parties import OrderCounterpartyRole

    return OrderCounterpartyRole(
        order_id=order_id, counterparty_id=counterparty_id, role=role
    )


def add_customer_role(
    session: Session, order_id: int, customer_id: int, role: str, *,
    actor: str, user: CurrentUser | None = None,
) -> Order:
    """向已有订单追加客户角色（按 order_id+customer_id+role 去重）；

    用于库存售出时把买家挂到来源单——来源单在入库时已建档，售出不再新建订单。
    """
    order = get_order(session, order_id, user)
    # 与建单同一套参与方护栏：角色合法、符合订单类型白名单、客户仍可用。
    # 缺任一校验都会让「售后追挂买家」绕过停用/合并客户与角色白名单。
    _validate_participant_roles(order.order_type, [(customer_id, role)], [])
    assert_customer_usable(session, customer_id, user=user)
    from app.domain.parties import OrderCustomerRole
    from sqlalchemy import select

    existing = session.scalar(
        select(OrderCustomerRole.id).where(
            OrderCustomerRole.order_id == order_id,
            OrderCustomerRole.customer_id == customer_id,
            OrderCustomerRole.role == role,
        )
    )
    if existing is None:
        session.add(_customer_role(order_id, customer_id, role))
        session.flush()
    return order


def add_counterparty_role(
    session: Session, order_id: int, counterparty_id: int, role: str, *,
    actor: str, user: CurrentUser | None = None,
) -> Order:
    """向已有订单追加合作方角色（详情编辑使用）。"""
    order = get_order(session, order_id, user)
    _validate_participant_roles(order.order_type, [], [(counterparty_id, role)])
    assert_counterparty_usable(session, counterparty_id, expected_type=role)
    from app.domain.parties import OrderCounterpartyRole

    existing = session.scalar(
        select(OrderCounterpartyRole.id).where(
            OrderCounterpartyRole.order_id == order_id,
            OrderCounterpartyRole.counterparty_id == counterparty_id,
            OrderCounterpartyRole.role == role,
        )
    )
    if existing is None:
        session.add(_counterparty_role(order_id, counterparty_id, role))
        session.flush()
    return order
