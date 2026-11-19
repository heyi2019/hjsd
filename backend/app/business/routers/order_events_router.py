"""orders 事件与客户角色路由（ORD-02）。

从 orders/router.py 按资源拆分，函数体一字未改，URL 与挂载点不变。
"""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import PermissionDenied
from app.core.security import (
    PERM_FINANCE_ORDER_EVENT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_EVENT_POST,
    PERM_ORDER_UPDATE,
    CurrentUser,
)
from app.settings.auth.session import (
    require_permissions,
)
from app.domain.trade import OrderEvent
from app.business import schemas
from app.shared.order_access import get_order as orders_get_order
from app.business.consignment import post_consignment_operation
from app.business.create import add_customer_role
from app.business.events import post_event as orders_post_event

from ..router_output import (
    _actor,
    _order_output,
    _operator_names,
    _event_output,
    cancellable_by_event,
)

router = APIRouter(tags=["ORD-01/02 订单与事件"])


read_orders = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
create_orders = require_permissions(PERM_ORDER_CREATE)
post_events = require_permissions(
    PERM_ORDER_EVENT_POST, PERM_FINANCE_ORDER_EVENT_POST, require_all=False
)
update_orders = require_permissions(PERM_ORDER_UPDATE)
edit_order_detail = require_permissions(PERM_ORDER_UPDATE)

@router.post("/orders/{order_id}/events", response_model=schemas.EventPostResult, status_code=201)
def post_event(
    order_id: int,
    payload: schemas.EventCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_events,
) -> schemas.EventPostResult:
    orders_get_order(db, order_id, user)
    event_type = payload.event_type.strip().upper()
    if user.has(PERM_FINANCE_ORDER_EVENT_POST) and not user.has(PERM_ORDER_EVENT_POST):
        if event_type not in {"BUY", "SELL"}:
            raise PermissionDenied(
                "财务只能登记买号或售出事件",
                details={"allowed_event_types": ["BUY", "SELL"], "event_type": event_type},
            )
    operation_type = (payload.operation_type or "").strip().upper()
    if event_type == "OPERATE" and operation_type in {"CONSIGNMENT", "UNLIST"}:
        event, flow = post_consignment_operation(
            db,
            order_id,
            operation_type=operation_type,
            occurred_on=payload.occurred_on,
            actor=_actor(user),
            note=payload.note,
            operator_user_ids=payload.operator_user_ids,
            form_extra=payload.form_extra,
            form_extra_scope=payload.form_extra_scope,
            user=user,
        )
    else:
        event, flow = orders_post_event(
            db,
            order_id,
            event_type=event_type,
            sale_mode=payload.sale_mode,
            operation_type=payload.operation_type,
            rebate_type=payload.rebate_type,
            amount=payload.amount,
            occurred_on=payload.occurred_on,
            actor=_actor(user),
            pool_id=payload.pool_id,
            portion=payload.portion,
            delivery_direction=payload.delivery_direction,
            offset_event_id=payload.offset_event_id,
            reason=payload.reason,
            operator_user_ids=payload.operator_user_ids,
            note=payload.note,
            bound_phone=payload.bound_phone,
            bound_phone_owner=payload.bound_phone_owner,
            form_extra_scope=payload.form_extra_scope,
            form_extra=payload.form_extra,
            user=user,
        )
    # 刚提交的事件要能立刻显示「还能冲多少」：把同订单事件一并取出算余额。
    order_events = list(
        db.scalars(select(OrderEvent).where(OrderEvent.order_id == event.order_id)).all()
    )
    return schemas.EventPostResult(
        event=_event_output(event, _operator_names(db, [event]), cancellable_by_event(order_events)),
        cashflow_no=flow.flow_no if flow else None,
    )
@router.post("/orders/{order_id}/customer-roles", response_model=schemas.OrderOut)
def add_order_customer_role(
    order_id: int,
    payload: schemas.CustomerRoleInput,
    db: Session = Depends(get_db),
    user: CurrentUser = update_orders,
) -> schemas.OrderOut:
    """向已有订单追加客户角色（如库存售出时把买家挂到来源单）。"""
    add_customer_role(
        db, order_id, payload.customer_id, payload.role,
        actor=_actor(user), user=user,
    )
    order = orders_get_order(db, order_id, user)
    return _order_output(order)

__all__ = ["router"]
