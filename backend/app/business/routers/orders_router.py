"""orders 主订单路由（ORD-01）。

从 orders/router.py 按资源拆分，函数体一字未改，URL 与挂载点不变。
"""
from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import PermissionDenied, Validation
from app.core.money import to_money
from app.core.schemas import PageOut
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
from app.domain.enums import AccountingAttribute, CashflowSourceType, Direction
from app.domain.trade import Account
from app.settings.field_definitions.pools import require_default_pool
from app.business import schemas
from app.shared.order_access import get_order as orders_get_order
from app.business.cancellation_model import cancel_order as orders_cancel_order
from app.business.deletion import delete_order as orders_delete_order
from app.business.create import create_order as orders_create_order
from app.business.events import post_event as orders_post_event
from app.business.participants import resolve_counterparty_role, resolve_customer_role
from app.business.mutations import update_order as orders_update_order
from app.business.orders.queries import (
    count_orders,
    list_orders as orders_list_orders,
    order_ledger_summary,
)

from ..orders.router_output import (
    _actor,
    _order_output,
    _order_detail_output,
    _order_list_payload,
)

router = APIRouter(tags=["ORD-01/02 订单与事件"])


read_orders = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
create_orders = require_permissions(PERM_ORDER_CREATE)
post_events = require_permissions(
    PERM_ORDER_EVENT_POST, PERM_FINANCE_ORDER_EVENT_POST, require_all=False
)
update_orders = require_permissions(PERM_ORDER_UPDATE)
edit_order_detail = require_permissions(PERM_ORDER_UPDATE)

@router.get("/orders", response_model=PageOut[schemas.OrderListOut])
def list_orders(
    order_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    trade_date_from: date | None = Query(default=None),
    trade_date_to: date | None = Query(default=None),
    owner_id: int | None = Query(default=None, gt=0),
    pool_id: int | None = Query(default=None, gt=0),
    keyword: str | None = Query(default=None, max_length=128),
    inventory_operator_ids: list[int] | None = Query(default=None),
    sale_operator_ids: list[int] | None = Query(default=None),
    business_mode: str | None = Query(default=None),
    game_type: str | None = Query(default=None),
    account_status: str | None = Query(default=None),
    sort_desc: bool | None = Query(default=None),
    mine: bool = Query(default=False),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_orders,
) -> list[schemas.OrderListOut]:
    orders = orders_list_orders(
        db,
        order_type=order_type,
        status=status,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        owner_id=owner_id,
        pool_id=pool_id,
        keyword=keyword,
        inventory_operator_ids=inventory_operator_ids,
        sale_operator_ids=sale_operator_ids,
        business_mode=business_mode,
        game_type=game_type,
        account_status=account_status,
        sort_desc=sort_desc,
        mine=mine,
        limit=limit,
        offset=offset,
        user=_user,
    )
    return PageOut(
        items=[schemas.OrderListOut.model_validate(item) for item in _order_list_payload(db, orders)],
        total=count_orders(
            db, order_type=order_type, status=status, trade_date_from=trade_date_from,
            trade_date_to=trade_date_to, owner_id=owner_id, pool_id=pool_id,
            keyword=keyword, business_mode=business_mode, game_type=game_type,
            account_status=account_status, inventory_operator_ids=inventory_operator_ids,
            sale_operator_ids=sale_operator_ids, user=_user, mine=mine,
        ),
        limit=limit,
        offset=offset,
    )
@router.get("/orders/ledger-summary", response_model=schemas.OrderLedgerSummaryOut)
def order_ledger_summary_endpoint(
    mine: bool = Query(default=False),
    trade_date_from: date | None = Query(default=None),
    trade_date_to: date | None = Query(default=None),
    order_type: str | None = Query(default=None),
    business_mode: str | None = Query(default=None),
    game_type: str | None = Query(default=None),
    account_status: str | None = Query(default=None),
    keyword: str | None = Query(default=None, max_length=128),
    inventory_operator_ids: list[int] | None = Query(default=None),
    sale_operator_ids: list[int] | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = read_orders,
) -> schemas.OrderLedgerSummaryOut:
    counts = order_ledger_summary(
        db,
        order_type=order_type,
        business_mode=business_mode,
        game_type=game_type,
        account_status=account_status,
        keyword=keyword,
        inventory_operator_ids=inventory_operator_ids,
        sale_operator_ids=sale_operator_ids,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        user=user,
        mine=mine,
    )
    return schemas.OrderLedgerSummaryOut(**counts)
@router.post("/orders", response_model=schemas.OrderOut, status_code=201)
def create_order(
    payload: schemas.OrderCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = create_orders,
) -> schemas.OrderOut:
    normalized_order_type = payload.order_type.strip().upper()
    if payload.initial_buy is not None and normalized_order_type not in {"HS", "TH"}:
        raise Validation("只有 HS 或 TH 订单可以在创建时提交初始买入")
    if payload.initial_costs and (normalized_order_type not in {"HS", "TH"} or payload.initial_buy is None):
        raise Validation("初始费用仅适用于同时提交初始买入的回收或提号订单")
    if normalized_order_type in {"HS", "TH"} and payload.initial_buy is not None:
        if not (user.has(PERM_ORDER_EVENT_POST) or user.has(PERM_FINANCE_ORDER_EVENT_POST)):
            raise PermissionDenied("无权登记买入事件")
        if payload.initial_costs and not user.has(PERM_ORDER_EVENT_POST):
            raise PermissionDenied("无权登记费用事件")
    owner_id = (
        payload.owner_id
        if user.is_admin or user.owner_scope == "ALL"
        else user.id
    )
    customer_roles = [(role.customer_id, role.role) for role in payload.customer_roles]
    counterparty_roles = [
        (role.counterparty_id, role.role) for role in payload.counterparty_roles
    ]
    customer_role = resolve_customer_role(db, payload.customer_input, user, update_existing=True)
    counterparty_role = resolve_counterparty_role(db, payload.counterparty_input, user)
    if customer_role is not None:
        customer_roles.append(customer_role)
    if counterparty_role is not None:
        counterparty_roles.append(counterparty_role)
    order = orders_create_order(
        db,
        order_type=normalized_order_type,
        trade_date=payload.trade_date,
        account_snapshot=(
            payload.account_snapshot.model_dump(exclude_none=True)
            if payload.account_snapshot is not None
            else None
        ),
        actor=_actor(user),
        account_id=payload.account_id,
        confirm_repurchase=payload.confirm_repurchase,
        owner_id=owner_id,
        note=payload.note,
        customer_roles=customer_roles,
        counterparty_roles=counterparty_roles,
        extra_values=payload.extra_values,
        form_extra=payload.form_extra,
        user=user,
    )
    if payload.initial_buy is not None:
        orders_post_event(
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
    for cost in payload.initial_costs:
        # 初始费用是支出资金明细；业务事件只记录
        # BUY/SELL/DELIVER/OPERATE 等业务事实。账号成本仍由这笔订单支出明细累计。
        pool_id = cost.pool_id or require_default_pool(db).id
        from app.business.collaboration import create_cashflow

        # 初始成本流水由 finance 域经 collaboration 注册点提供挂账器，
        # orders 不再反向 import finance.cashflows（backend/.importlinter 契约）。
        # 初始成本核算属性：回收/提号各归其位（2026-11-18 用户裁决：
        # 「提号就是提号成本」）；DG 代挂无独立成本属性，初始成本落其他支出。
        initial_cost_attribute = {
            "HS": AccountingAttribute.SELF_DIRECT_COST.value,
            "TH": AccountingAttribute.TH_DIRECT_COST.value,
        }.get(order.order_type, AccountingAttribute.OTHER_EXPENSE.value)
        create_cashflow(
            db,
            pool_id=pool_id,
            occurred_on=cost.occurred_on,
            direction=Direction.OUT.value,
            accounting_attribute=initial_cost_attribute,
            category=cost.flow_category or "OTHER",
            amount=cost.amount,
            source_type=CashflowSourceType.ORDER.value,
            source_id=order.order_no,
            actor=_actor(user),
            order_id=order.id,
            note=cost.note,
            user=user,
        )
        account = db.get(Account, order.account_id) if order.account_id else None
        if account is not None:
            account.cost_amount = to_money(account.cost_amount) + to_money(cost.amount)
            account.updated_by = _actor(user)
    return _order_output(order)
@router.get("/orders/{order_id}", response_model=schemas.OrderDetailOut)
def get_order(
    order_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_orders,
) -> schemas.OrderDetailOut:
    return _order_detail_output(db, orders_get_order(db, order_id, _user), _user)
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
    order = orders_update_order(
        db, order_id, actor=_actor(user), user=user, **changes
    )
    return _order_output(order)
@router.delete("/orders/{order_id}", status_code=204, response_model=None)
def delete_order(
    order_id: int,
    payload: schemas.OrderDeleteIn,
    db: Session = Depends(get_db),
    user: CurrentUser = update_orders,
) -> Response:
    """管理员物理删除绑定业务及全部从属数据。"""
    if not user.is_admin:
        raise PermissionDenied("仅系统管理员可执行删除")
    orders_delete_order(
        db,
        order_id,
        actor=_actor(user),
        reason=payload.reason,
        user=user,
    )
    return Response(status_code=204)
@router.post("/orders/{order_id}/cancel", response_model=schemas.OrderOut)
def cancel_order(
    order_id: int,
    payload: schemas.OrderCancelIn,
    db: Session = Depends(get_db),
    user: CurrentUser = update_orders,
) -> schemas.OrderOut:
    order = orders_cancel_order(
        db,
        order_id,
        actor=_actor(user),
        reason=payload.reason,
        form_extra=payload.form_extra,
        form_extra_scope="ORDERCANC",
        user=user,
    )
    return _order_output(order)

__all__ = ["router"]
