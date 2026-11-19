"""orders 事件与客户角色路由（ORD-02）。

从 orders/router.py 按资源拆分，函数体一字未改，URL 与挂载点不变。
"""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import PermissionDenied, Validation
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
from app.domain.trade import Order, OrderEvent
from app.business import schemas
from app.shared.order_access import get_order as orders_get_order
from app.business.consignment import post_consignment_operation
from app.business.create import add_customer_role
from app.business.events import post_event as orders_post_event
from app.business.cancellation_model import cancel_order as orders_cancel_order

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

@router.post("/orders/{order_id}/inventory-offsale")
def inventory_offsale(
    order_id: int,
    payload: schemas.InventoryOffsaleIn,
    db: Session = Depends(get_db),
    user: CurrentUser = update_orders,
) -> dict[str, bool]:
    """平台下架与库存出库共用一次请求事务。"""
    order = orders_get_order(db, order_id, user)
    order = db.execute(
        select(Order).where(Order.id == order.id).with_for_update().execution_options(populate_existing=True)
    ).scalar_one()
    if order.account_id is None:
        raise Validation("订单未关联库存账号")
    if payload.unlisted_at.tzinfo is not None or payload.unlisted_at.date() != payload.occurred_on:
        raise Validation("下架时间须为本地时间且日期须与业务日期一致")
    if not user.has(PERM_ORDER_EVENT_POST):
        raise PermissionDenied("当前角色无权登记库存下架事件")
    events = list(db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all())
    unlisted: set[tuple[str, str]] = set()
    system_unlisted_event_ids: set[str] = set()
    for event in events:
        extra = event.form_extra or {}
        if event.event_type == "OPERATE" and extra.get("operation_type") == "UNLIST":
            if extra.get("consignment_event_id") is not None:
                if extra.get("platform_unlist_scope") == "SYSTEM":
                    system_unlisted_event_ids.add(str(extra["consignment_event_id"]))
            for platform in extra.get("consignment_platforms") or []:
                unlisted.add((str(extra.get("consignment_event_id")), str(platform)))
    extra_base = {**(payload.form_extra or {}), "platform_unlist_scope": "SYSTEM", "platform_unlisted_at": payload.unlisted_at.isoformat(timespec="minutes")}
    for event in events:
        extra = event.form_extra or {}
        if event.event_type != "OPERATE" or extra.get("operation_type") != "CONSIGNMENT":
            continue
        platforms = extra.get("consignment_platforms") or []
        for platform in platforms:
            if str(event.id) in system_unlisted_event_ids:
                continue
            if (str(event.id), str(platform)) in unlisted:
                continue
            orders_post_event(db, order.id, event_type="OPERATE", operation_type="UNLIST",
                occurred_on=payload.occurred_on, actor=_actor(user), operator_user_ids=payload.operator_user_ids,
                note="系统下架同步取消寄售平台上架", form_extra_scope="INVOID",
                form_extra={**extra_base, "platform_unlist_scope": "SYSTEM" if order.order_type == "DG" else "PLATFORM", "consignment_event_id": event.id, "consignment_platforms": [platform]}, user=user)
    if order.order_type == "DG":
        orders_cancel_order(db, order.id, actor=_actor(user), reason=payload.reason,
            form_extra=extra_base, form_extra_scope="INVOID", user=user)
    else:
        if payload.amount is None or payload.pool_id is None or payload.offset_event_id is None:
            raise Validation("回收库存出库必须提供冲销金额、资金账户和原事件")
        orders_post_event(db, order.id, event_type="CANCEL", amount=payload.amount,
            occurred_on=payload.occurred_on, actor=_actor(user), pool_id=payload.pool_id,
            portion=payload.portion, offset_event_id=payload.offset_event_id, reason=payload.reason,
            form_extra=payload.form_extra, note="账号下架，冲销买入", user=user)
    return {"ok": True}

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
