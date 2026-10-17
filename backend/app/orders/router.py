"""orders.router：订单、事件与资金池余额 API（ORD-01/02、FIN-01）。

金额类动作全部走 Service 事务；列表页只提供查询，不做直接过账。
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
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
    require_permissions,
)
from app.domain.parties import Customer, Counterparty, OrderCounterpartyRole, OrderCustomerRole
from app.domain.trade import Account, Installment, OrderEvent
from app.installments import service as installments_service
from app.orders import schemas, service

router = APIRouter(tags=["ORD-01/02 订单与事件"])

read_orders = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
create_orders = require_permissions(PERM_ORDER_CREATE)
post_events = require_permissions(
    PERM_ORDER_EVENT_POST, PERM_FINANCE_ORDER_EVENT_POST, require_all=False
)
update_orders = require_permissions(PERM_ORDER_UPDATE)
read_finance = require_permissions(PERM_FINANCE_READ)


def _actor(user: CurrentUser) -> str:
    return user.username


def _order_output(order, user: CurrentUser) -> schemas.OrderOut:
    """按订单权限输出详情，避免财务/查看权限读取 DFQ 游戏密码。"""
    output = schemas.OrderOut.model_validate(order)
    if not user.has(PERM_ORDER_CREATE) and output.account_snapshot:
        snapshot = dict(output.account_snapshot)
        if "game_password" in snapshot:
            snapshot["game_password"] = None
        output.account_snapshot = snapshot
    return output


def _event_output(event: OrderEvent) -> schemas.EventOut:
    """把审计字段映射为事件响应字段，避免 ORM 属性名泄漏到 API。"""
    return schemas.EventOut.model_validate(
        {
            "id": event.id,
            "event_no": event.event_no,
            "order_id": event.order_id,
            "event_type": event.event_type,
            "amount": event.amount,
            "occurred_on": event.occurred_on,
            "pool_id": event.pool_id,
            "offset_event_id": event.offset_event_id,
            "portion": event.portion,
            "delivery_mode": event.delivery_mode,
            "is_posted": event.is_posted,
            "posted_at": event.posted_at,
            "reason": event.reason,
            "note": event.note,
            "created_at": event.created_at,
            "operator": event.created_by,
        }
    )


def _order_detail_output(
    db: Session, order, user: CurrentUser
) -> schemas.OrderDetailOut:
    """订单详情统一返回主字段和执行事件，避免前端再拼接隐式查询。"""
    output = schemas.OrderDetailOut.model_validate(order)
    if not user.has(PERM_ORDER_CREATE) and output.account_snapshot:
        snapshot = dict(output.account_snapshot)
        if "game_password" in snapshot:
            snapshot["game_password"] = None
        output.account_snapshot = snapshot
    events = db.scalars(
        select(OrderEvent)
        .where(OrderEvent.order_id == order.id)
        .order_by(OrderEvent.occurred_on, OrderEvent.id)
    ).all()
    output.events = [_event_output(event) for event in events]
    return output


def _order_list_payload(db: Session, orders: list) -> list[dict]:
    """组装工作台摘要，避免列表页为每一行再请求详情。"""
    order_ids = [item.id for item in orders]
    account_ids = [item.account_id for item in orders if item.account_id is not None]
    accounts = (
        {item.id: item for item in db.scalars(select(Account).where(Account.id.in_(account_ids))).all()}
        if account_ids else {}
    )

    parties: dict[int, tuple[str, str, str | None, str, datetime]] = {}
    if order_ids:
        for role, customer in db.execute(
            select(OrderCustomerRole, Customer)
            .join(Customer, Customer.id == OrderCustomerRole.customer_id)
            .where(OrderCustomerRole.order_id.in_(order_ids))
        ).all():
            parties.setdefault(role.order_id, (customer.display_name, role.role, customer.source, customer.created_by, customer.created_at))
        for role, counterparty in db.execute(
            select(OrderCounterpartyRole, Counterparty)
            .join(Counterparty, Counterparty.id == OrderCounterpartyRole.counterparty_id)
            .where(OrderCounterpartyRole.order_id.in_(order_ids))
        ).all():
            parties.setdefault(role.order_id, (counterparty.display_name, role.role, counterparty.source, counterparty.created_by, counterparty.created_at))

    events_by_order: dict[int, list[OrderEvent]] = {}
    if order_ids:
        for event in db.scalars(
            select(OrderEvent)
            .where(OrderEvent.order_id.in_(order_ids), OrderEvent.is_posted.is_(True))
            .order_by(OrderEvent.occurred_on.desc(), OrderEvent.id.desc())
        ).all():
            events_by_order.setdefault(event.order_id, []).append(event)

    installments = (
        {item.order_id: item for item in db.scalars(select(Installment).where(Installment.order_id.in_(order_ids))).all()}
        if order_ids else {}
    )

    payloads: list[dict] = []
    for order in orders:
        account = accounts.get(order.account_id)
        snapshot = order.account_snapshot or {}
        events = events_by_order.get(order.id, [])
        installment = installments.get(order.id)
        latest = events[0] if events else None
        party = parties.get(order.id)
        payloads.append({
            "id": order.id,
            "order_no": order.order_no,
            "order_type": order.order_type,
            "capital_type": order.capital_type,
            "trade_date": order.trade_date,
            "listing_price": order.listing_price,
            "service_fee": order.service_fee,
            "commission_mode": order.commission_mode,
            "commission_payer": order.commission_payer,
            "expected_settlement_date": order.expected_settlement_date,
            "account_id": order.account_id,
            "status": order.status,
            "link_status": order.link_status,
            "owner_id": order.owner_id,
            "note": order.note,
            "created_at": order.created_at,
            # DFQ / TH 只有订单文本快照，没有库存账号；列表展示安全的业务字段，
            # 不把快照中的 game_password 原样带入列表响应。
            "account_game_type": account.game_type if account else snapshot.get("game_type"),
            "account_game_account": account.game_account if account else snapshot.get("game_account"),
            "account_channel_region": account.channel_region if account else snapshot.get("channel_region"),
            "account_business_mode": account.business_mode if account else None,
            "account_platform": account.platform if account else snapshot.get("platform"),
            "account_status": account.status if account else None,
            "party_name": party[0] if party else None,
            "party_role": party[1] if party else None,
            "party_source": party[2] if party else None,
            "party_created_by": party[3] if party else None,
            "party_created_at": party[4] if party else None,
            "event_total": sum((event.amount for event in events), 0),
            "last_event_type": latest.event_type if latest else None,
            "last_event_amount": latest.amount if latest else None,
            "last_event_on": latest.occurred_on if latest else None,
            "installment_principal": installment.principal if installment else None,
            "installment_paid": installment.paid_amount if installment else None,
            "installment_periods": installment.periods if installment else None,
            "installment_status": installment.status if installment else None,
        })
    return payloads


@router.get("/orders", response_model=list[schemas.OrderListOut])
def list_orders(
    order_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_orders,
) -> list[schemas.OrderListOut]:
    orders = service.list_orders(db, order_type=order_type, status=status, user=_user)
    return [schemas.OrderListOut.model_validate(item) for item in _order_list_payload(db, orders)]


@router.post("/orders", response_model=schemas.OrderOut, status_code=201)
def create_order(
    payload: schemas.OrderCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = create_orders,
) -> schemas.OrderOut:
    if (payload.initial_buy is None) != (payload.installment is None):
        raise Validation("初始买入和分期合约必须同时提交")
    normalized_order_type = payload.order_type.strip().upper()
    if payload.initial_buy is not None and normalized_order_type != "DFQ":
        raise Validation("只有 DFQ 订单可以在创建时提交初始买入和代分期合约")
    owner_id = (
        payload.owner_id
        if user.is_admin or user.owner_scope == "ALL"
        else user.id
    )
    order = service.create_order(
        db,
        order_type=normalized_order_type,
        trade_date=payload.trade_date,
        listing_price=payload.listing_price,
        service_fee=payload.service_fee,
        commission_mode=payload.commission_mode,
        commission_payer=payload.commission_payer,
        expected_settlement_date=payload.expected_settlement_date,
        account_snapshot=(
            payload.account_snapshot.model_dump(exclude_none=True)
            if payload.account_snapshot is not None
            else None
        ),
        actor=_actor(user),
        account_id=payload.account_id,
        account_profile=payload.account.model_dump() if payload.account else None,
        owner_id=owner_id,
        capital_type=payload.capital_type,
        note=payload.note,
        customer_roles=[
            (role.customer_id, role.role)
            for role in payload.customer_roles
            if role.customer_id is not None
        ],
        counterparty_roles=[
            (role.counterparty_id, role.role)
            for role in payload.counterparty_roles
            if role.counterparty_id is not None
        ],
        user=user,
    )
    if payload.initial_buy is not None and payload.installment is not None:
        installments_service.create_installment(
            db,
            order_id=order.id,
            contract_type=payload.installment.contract_type,
            principal=payload.installment.principal,
            down_payment=payload.installment.down_payment,
            service_fee=payload.installment.service_fee,
            periods=payload.installment.periods,
            per_period_service_fee=payload.installment.per_period_service_fee,
            per_period=payload.installment.per_period,
            first_due_on=payload.installment.first_due_on,
            delivery_mode=payload.installment.delivery_mode,
            note=payload.installment.note,
            schedule=(
                [item.model_dump() for item in payload.installment.schedule]
                if payload.installment.schedule
                else None
            ),
            actor=_actor(user),
            user=user,
        )
        service.post_event(
            db,
            order.id,
            event_type="BUY",
            amount=payload.initial_buy.amount,
            occurred_on=payload.initial_buy.occurred_on,
            actor=_actor(user),
            pool_id=payload.initial_buy.pool_id,
            portion=payload.initial_buy.portion,
            note=payload.initial_buy.note,
            user=user,
        )
    return _order_output(order, user)


@router.get("/orders/{order_id}", response_model=schemas.OrderDetailOut)
def get_order(
    order_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_orders,
) -> schemas.OrderDetailOut:
    return _order_detail_output(db, service.get_order(db, order_id, _user), _user)


@router.patch("/orders/{order_id}", response_model=schemas.OrderOut)
def update_order(
    order_id: int,
    payload: schemas.OrderUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = update_orders,
) -> schemas.OrderOut:
    changes = {
        field: getattr(payload, field)
        for field in payload.model_fields_set
    }
    if "account_snapshot" in changes and changes["account_snapshot"] is not None:
        changes["account_snapshot"] = changes["account_snapshot"].model_dump()
    order = service.update_order(
        db, order_id, actor=_actor(user), user=user, **changes
    )
    return _order_output(order, user)


@router.post("/orders/{order_id}/cancel", response_model=schemas.OrderOut)
def cancel_order(
    order_id: int,
    payload: schemas.OrderCancelIn,
    db: Session = Depends(get_db),
    user: CurrentUser = update_orders,
) -> schemas.OrderOut:
    order = service.cancel_order(
        db,
        order_id,
        actor=_actor(user),
        reason=payload.reason,
        user=user,
    )
    return _order_output(order, user)


@router.post("/orders/{order_id}/events", response_model=schemas.EventPostResult, status_code=201)
def post_event(
    order_id: int,
    payload: schemas.EventCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_events,
) -> dict:
    service.get_order(db, order_id, user)
    event_type = payload.event_type.strip().upper()
    if user.has(PERM_FINANCE_ORDER_EVENT_POST) and not user.has(PERM_ORDER_EVENT_POST):
        if event_type not in {"BUY", "SELL"}:
            raise PermissionDenied(
                "财务只能登记付款或回款事件",
                details={"allowed_event_types": ["BUY", "SELL"], "event_type": event_type},
            )
    event, flow = service.post_event(
        db,
        order_id,
        event_type=event_type,
        amount=payload.amount,
        occurred_on=payload.occurred_on,
        actor=_actor(user),
        pool_id=payload.pool_id,
        portion=payload.portion,
        delivery_mode=payload.delivery_mode,
        offset_event_id=payload.offset_event_id,
        reason=payload.reason,
        flow_category=payload.flow_category,
        note=payload.note,
        user=user,
    )
    return {
        "event": _event_output(event),
        "cashflow_no": flow.flow_no if flow else None,
    }


@router.get("/pools/{pool_id}/balance", response_model=schemas.PoolBalanceOut)
def pool_balance(
    pool_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_finance,
) -> dict:
    if not _user.can_see_pool(pool_id):
        from app.core.errors import NotFound
        raise NotFound("资金池不存在", details={"pool_id": pool_id})
    return service.pool_balance(db, pool_id, user=_user)


__all__ = ["router"]
