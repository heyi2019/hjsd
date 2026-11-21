"""orders 事件与客户角色路由（ORD-02）。

从 orders/router.py 按资源拆分，函数体一字未改，URL 与挂载点不变。
"""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import PermissionDenied, Validation
from app.core.state_machine import ACCOUNT_TRANSITIONS, ORDER_TRANSITIONS, transition
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
from app.domain.trade import Account, Order, OrderEvent
from app.shared.audit import record_audit
from app.shared.form_field_rules import validate_form_extra
from app.business import schemas
from app.shared.order_access import get_order as orders_get_order
from app.business.consignment import post_consignment_operation
from app.business.orders.create import add_customer_role
from app.business.events import post_event as orders_post_event
from app.business.cancellation_model import cancel_order as orders_cancel_order
from app.business.sale import apply_sale_details, sale_form_context

from ..orders.router_output import (
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
    if not payload.reason.strip():
        raise Validation("取消必须填写原因")
    if not user.has(PERM_ORDER_EVENT_POST):
        raise PermissionDenied("当前角色无权登记库存下架事件")
    form_scope = "INVOID" if order.order_type == "DG" else "INVREFUND"
    field_context = {
        "reason": payload.reason, "amount": payload.amount, "pool_id": payload.pool_id,
        "offset_event_id": payload.offset_event_id, "operator_user_ids": payload.operator_user_ids,
        "occurred_on": payload.occurred_on, "unlisted_at": payload.unlisted_at,
        "listing_id": "SYSTEM" if order.order_type == "DG" else None,
    }
    checked_extra = validate_form_extra(
        db, order_type_code=form_scope, values=payload.form_extra, context=field_context,
    )
    events = list(db.scalars(select(OrderEvent).where(OrderEvent.order_id == order.id)).all())
    if order.order_type != "DG":
        if payload.amount is None:
            raise Validation("请填写退回金额")
        if payload.amount > 0:
            if payload.pool_id is None or payload.offset_event_id is None:
                raise Validation("有退款时必须选择资金账户和买入流水")
            offset = next((event for event in events if event.is_posted and event.id == payload.offset_event_id and event.event_type == "BUY"), None)
            if offset is None:
                raise Validation("取消入库必须选择本订单的买入流水")
        account = db.scalar(select(Account).where(Account.id == order.account_id).with_for_update())
        if account is None or account.status != "WAITING":
            raise Validation("只有在库账号才能取消入库")
    unlisted: set[tuple[str, str]] = set()
    system_unlisted_event_ids: set[str] = set()
    for event in events:
        extra = event.form_extra or {}
        if event.event_type == "OPERATE" and extra.get("operation_type") == "UNLIST":
            if extra.get("consignment_event_id") is not None:
                if extra.get("platform_unlist_scope") == "SYSTEM":
                    system_unlisted_event_ids.add(str(extra["consignment_event_id"]))
            for platform in extra.get("consignment_platforms") or []:
                unlisted.add((str(extra.get("consignment_event_id")), str(platform).strip()))
    extra_base = {**checked_extra, "platform_unlist_scope": "SYSTEM", "platform_unlisted_at": payload.unlisted_at.isoformat(timespec="minutes")}
    for event in events:
        extra = event.form_extra or {}
        if event.event_type != "OPERATE" or extra.get("operation_type") != "CONSIGNMENT":
            continue
        platforms = extra.get("consignment_platforms") or []
        for platform in platforms:
            if str(event.id) in system_unlisted_event_ids:
                continue
            if (str(event.id), str(platform).strip()) in unlisted:
                continue
            orders_post_event(db, order.id, event_type="OPERATE", operation_type="UNLIST",
                occurred_on=payload.occurred_on, actor=_actor(user), operator_user_ids=payload.operator_user_ids,
                note="系统下架同步取消寄售平台上架", form_extra_scope=form_scope, form_extra_context=field_context,
                form_extra={**extra_base, "platform_unlist_scope": "SYSTEM" if order.order_type == "DG" else "PLATFORM", "consignment_event_id": event.id, "consignment_platforms": [platform]}, user=user)
    if order.order_type == "DG":
        orders_cancel_order(db, order.id, actor=_actor(user), reason=payload.reason,
            form_extra=extra_base, form_extra_scope="INVOID", form_extra_context=field_context, user=user)
    else:
        if payload.amount > 0:
            orders_post_event(db, order.id, event_type="CANCEL", amount=payload.amount,
                occurred_on=payload.occurred_on, actor=_actor(user), pool_id=payload.pool_id,
                portion=payload.portion, offset_event_id=payload.offset_event_id, reason=payload.reason,
                operator_user_ids=payload.operator_user_ids,
                form_extra=checked_extra, form_extra_scope=form_scope, form_extra_context=field_context,
                note="取消入库，冲销买入", user=user)
        if order.status != "CANCELLED":
            before = {"order_status": order.status, "account_status": account.status}
            order.status = transition(ORDER_TRANSITIONS, order.status, "CANCEL", entity="订单")
            account.status = transition(ACCOUNT_TRANSITIONS, account.status, "VOID", entity="账号")
            if checked_extra:
                order.form_extra = {**(order.form_extra or {}), **checked_extra}
            order.updated_by = account.updated_by = _actor(user)
            record_audit(db, action="ORDER_CANCEL", entity_type="inventory_cancel", entity_id=order.order_no,
                actor=_actor(user), before=before, after={"order_status": order.status, "account_status": account.status}, reason=payload.reason)
    return {"ok": True}

@router.post("/orders/{order_id}/stock-sale", response_model=schemas.EventPostResult, status_code=201)
def stock_sale(
    order_id: int,
    payload: schemas.StockSaleIn,
    db: Session = Depends(get_db),
    user: CurrentUser = post_events,
) -> schemas.EventPostResult:
    apply_sale_details(db, order_id, customer_input=payload.customer_input,
                       delivery_form_extra=payload.delivery_form_extra, user=user)
    field_context = sale_form_context(payload.customer_input, payload.delivery_form_extra)
    field_context.update({
        "sale_amount": payload.sale_amount,
        "bound_phone": payload.bound_phone if payload.bound_phone is not None else field_context["bound_phone"],
        "bound_phone_owner": payload.bound_phone_owner if payload.bound_phone_owner is not None else field_context["bound_phone_owner"],
    })
    event, flow = orders_post_event(
        db, order_id, event_type="SELL", sale_mode="FULL", amount=payload.amount,
        occurred_on=payload.occurred_on, actor=_actor(user), pool_id=payload.pool_id,
        portion="PROFIT", operator_user_ids=payload.operator_user_ids, note=payload.note,
        bound_phone=field_context["bound_phone"], bound_phone_owner=field_context["bound_phone_owner"],
        form_extra={**(payload.form_extra or {}), **({"sale_amount": str(payload.sale_amount)} if payload.sale_amount is not None else {})},
        form_extra_context=field_context,
        user=user,
    )
    events = list(db.scalars(select(OrderEvent).where(OrderEvent.order_id == event.order_id)).all())
    return schemas.EventPostResult(event=_event_output(event, _operator_names(db, [event]), cancellable_by_event(events)),
                                   cashflow_no=flow.flow_no if flow else None)


@router.post("/orders/{order_id}/events", response_model=schemas.EventPostResult, status_code=201)
def post_event(
    order_id: int,
    payload: schemas.EventCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_events,
) -> schemas.EventPostResult:
    order = orders_get_order(db, order_id, user)
    event_type = payload.event_type.strip().upper()
    if payload.finalize_sale_cancel:
        order = db.execute(select(Order).where(Order.id == order.id).with_for_update().execution_options(populate_existing=True)).scalar_one()
        offset = db.get(OrderEvent, payload.offset_event_id) if payload.offset_event_id else None
        account = db.scalar(select(Account).where(Account.id == order.account_id).with_for_update()) if order.account_id else None
        latest_sell_id = db.scalar(select(OrderEvent.id).where(
            OrderEvent.order_id == order.id, OrderEvent.event_type == "SELL", OrderEvent.is_posted.is_(True),
        ).order_by(OrderEvent.id.desc()).limit(1))
        if order.order_type not in {"HS", "TH"} or event_type != "CANCEL" or offset is None or offset.order_id != order.id or offset.event_type != "SELL" or not offset.is_posted or offset.id != latest_sell_id or account is None or account.status != "SOLD" or order.status != "COMPLETED":
            raise Validation("取消售出必须选择该订单已售出的流水")
    if user.has(PERM_FINANCE_ORDER_EVENT_POST) and not user.has(PERM_ORDER_EVENT_POST):
        if event_type not in {"BUY", "SELL"}:
            raise PermissionDenied(
                "财务只能登记买号或售出事件",
                details={"allowed_event_types": ["BUY", "SELL"], "event_type": event_type},
            )
    operation_type = (payload.operation_type or "").strip().upper()
    if event_type == "OPERATE" and operation_type == "UNLIST" and str((payload.form_extra or {}).get("platform_unlist_scope") or "").strip().upper() == "SYSTEM":
        raise Validation("本系统下架请通过下架操作执行")
    if event_type == "OPERATE" and operation_type in {"CONSIGNMENT", "UNLIST"}:
        event, flow = post_consignment_operation(
            db,
            order_id,
            operation_type=operation_type,
            occurred_on=payload.occurred_on,
            actor=_actor(user),
            note=payload.note,
            reason=payload.reason,
            operator_user_ids=payload.operator_user_ids,
            form_extra=payload.form_extra,
            form_extra_scope="CONSIGN" if operation_type == "CONSIGNMENT" else "INVOID",
            user=user,
        )
    else:
        form_scope = payload.form_extra_scope
        if event_type == "CANCEL":
            offset = db.get(OrderEvent, payload.offset_event_id) if payload.offset_event_id else None
            form_scope = "INVREFUND" if offset is not None and offset.event_type == "BUY" else "ORDERCANC"
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
            form_extra_scope=form_scope,
            form_extra=payload.form_extra,
            user=user,
        )
    if payload.finalize_sale_cancel and order.status == "COMPLETED":
        before = {"order_status": order.status, "account_status": account.status}
        order.status = transition(ORDER_TRANSITIONS, order.status, "CANCEL_SELL", entity="订单")
        account.status = transition(ACCOUNT_TRANSITIONS, account.status, "CANCEL_SELL", entity="账号")
        order.updated_by = account.updated_by = _actor(user)
        record_audit(db, action="ORDER_CANCEL", entity_type="sale_cancel", entity_id=order.order_no,
            actor=_actor(user), before=before, after={"order_status": order.status, "account_status": account.status}, reason=payload.reason)
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
