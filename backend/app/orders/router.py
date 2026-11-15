"""orders.router：订单、事件与资金池余额 API（ORD-01/02、FIN-01）。

金额类动作全部走 Service 事务；列表页只提供查询，不做直接登记。
"""

from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select
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
    require_permissions,
)
from app.domain.enums import AccountingAttribute, Direction, FundNature, Nature, OrderStatus
from app.domain.trade import Account, OrderEvent
from app.foundation.order_types import resolve_default_pool
from app.value_added_services import create as inst_create
from app.orders import schemas
from app.orders._shared import get_order as orders_get_order
from app.orders.cancellation_model import cancel_order as orders_cancel_order
from app.orders.consignment import post_consignment_operation
from app.orders.deletion import delete_order as orders_delete_order
from app.orders.create import add_customer_role, create_order as orders_create_order
from app.orders.events import post_event as orders_post_event
from app.orders.participants import resolve_counterparty_role, resolve_customer_role
from app.orders.order_detail.editing import edit_execution_detail
from app.orders.order_detail.editing.schemas import ExecutionEditRequest
from app.orders.order_detail.view.execution import load_order_execution_detail
from app.orders.order_detail.view.execution_schemas import AccountExecutionDetailOut
from app.orders.links import (
    create_order_link as orders_create_order_link,
    delete_order_link as orders_delete_order_link,
    list_order_links as orders_list_order_links,
)
from app.orders.mutations import update_order as orders_update_order
from app.finance.balances import pool_balance as finance_pool_balance, pool_balance_summary
from app.orders.queries import (
    count_orders,
    list_orders as orders_list_orders,
    order_ledger_summary,
    order_status_counts,
)

from .router_output import (
    _actor,
    _order_output,
    _operator_names,
    _event_output,
    _order_detail_output,
    _order_list_payload,
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
read_finance = require_permissions(PERM_FINANCE_READ)


@router.get("/orders/{order_id}/execution-detail", response_model=AccountExecutionDetailOut)
def order_execution_detail(
    order_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = read_orders,
) -> AccountExecutionDetailOut:
    """查询一个订单及其强绑定账号的执行详情。"""
    return load_order_execution_detail(db, order_id, user)


@router.patch("/orders/{order_id}/execution-edit")
def update_order_execution_detail(
    order_id: int,
    payload: ExecutionEditRequest,
    db: Session = Depends(get_db),
    user: CurrentUser = edit_order_detail,
) -> dict[str, bool]:
    """保存一个订单及其强绑定账号的详情编辑。"""
    order = orders_get_order(db, order_id, user)
    if order.account_id is None:
        raise Validation("订单未关联库存账号", details={"order_id": order_id})
    edit_execution_detail(db, order_id, payload, user)
    return {"ok": True}


@router.get("/orders", response_model=PageOut[schemas.OrderListOut])
def list_orders(
    order_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    trade_date_from: date | None = Query(default=None),
    trade_date_to: date | None = Query(default=None),
    owner_id: int | None = Query(default=None, gt=0),
    pool_id: int | None = Query(default=None, gt=0),
    keyword: str | None = Query(default=None, max_length=128),
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
            account_status=account_status, user=_user, mine=mine,
        ),
        limit=limit,
        offset=offset,
    )


@router.get("/orders/summary", response_model=schemas.OrderSummaryOut)
def order_summary(
    mine: bool = Query(default=False),
    trade_date_from: date | None = Query(default=None),
    trade_date_to: date | None = Query(default=None),
    db: Session = Depends(get_db),
    user: CurrentUser = read_orders,
) -> schemas.OrderSummaryOut:
    """工作台与数据中心订单卡片：按可见范围、日期和状态汇总。"""
    counts = order_status_counts(
        db,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        user=user,
        mine=mine,
    )
    return schemas.OrderSummaryOut(
        total_count=sum(counts.values()),
        completed_count=counts.get(OrderStatus.COMPLETED.value, 0),
        active_count=counts.get(OrderStatus.ACTIVE.value, 0) + counts.get(OrderStatus.INSTALLMENT.value, 0),
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
    if payload.installment is not None and normalized_order_type in {"TH", "DG"}:
        raise Validation("TH/DG 分期必须在出售动作中选择付款方式并建立分期合约")
    if payload.initial_buy is None and payload.installment is not None and normalized_order_type != "DG":
        raise Validation("TH 分期订单必须同时提交初始买入和分期合约")
    expected_contract_type = {
        "TH": "PICKUP_SALE",
        "DG": "CONSIGNMENT_SALE",
    }.get(normalized_order_type)
    if payload.installment is not None and payload.installment.contract_type != expected_contract_type:
        raise Validation(
            f"{normalized_order_type} 订单必须使用 {expected_contract_type} 分期合约",
            details={"contract_type": payload.installment.contract_type},
        )
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
    customer_role = resolve_customer_role(db, payload.customer_input, user)
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
        capital_type=payload.capital_type,
        note=payload.note,
        commission_mode=payload.commission_mode,
        commission_payer=payload.commission_payer,
        customer_roles=customer_roles,
        counterparty_roles=counterparty_roles,
        extra_values=payload.extra_values,
        form_extra=payload.form_extra,
        form_extra_scope=payload.form_extra_scope,
        user=user,
    )
    if payload.installment is not None:
        inst_create.create_installment(
            db,
            order_id=order.id,
            contract_type=payload.installment.contract_type,
            principal=payload.installment.principal,
            down_payment=payload.installment.down_payment,
            service_fee=payload.installment.service_fee,
            periods=payload.installment.periods,
            per_period_service_fee=payload.installment.per_period_service_fee,
            per_period=payload.installment.per_period,
            adjust_final_period=payload.installment.adjust_final_period,
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
        pool_id = cost.pool_id
        if pool_id is None:
            pool = resolve_default_pool(
                db,
                order.order_type,
                cost.portion,
                fund_nature=FundNature.BUSINESS.value,
            )
            if pool is None:
                raise Validation(
                    f"业务 {order.order_type} 未配置 {cost.portion} 资金池",
                    details={"order_type": order.order_type, "portion": cost.portion},
                )
            pool_id = pool.id
        from app.finance.cashflows import create_cashflow

        create_cashflow(
            db,
            pool_id=pool_id,
            occurred_on=cost.occurred_on,
            direction=Direction.OUT.value,
            nature=Nature.BUSINESS_OUT.value,
            fund_nature=FundNature.BUSINESS.value,
            accounting_attribute=(
                AccountingAttribute.SELF_DIRECT_COST.value
                if order.order_type == "HS"
                else AccountingAttribute.TH_DIRECT_COST.value
            ),
            category=cost.flow_category or "OTHER",
            amount=cost.amount,
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


@router.get("/orders/{order_id}/links", response_model=list[schemas.OrderLinkOut])
def list_order_links(
    order_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = read_orders,
) -> list[schemas.OrderLinkOut]:
    return [
        schemas.OrderLinkOut.model_validate(item)
        for item in orders_list_order_links(db, order_id, user)
    ]


@router.post(
    "/orders/{order_id}/links",
    response_model=schemas.OrderLinkOut,
    status_code=201,
)
def create_order_link(
    order_id: int,
    payload: schemas.OrderLinkCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = update_orders,
) -> schemas.OrderLinkOut:
    link = orders_create_order_link(
        db,
        order_id,
        related_order_id=payload.related_order_id,
        relation_type=payload.relation_type,
        split_ratio=payload.split_ratio,
        split_amount=payload.split_amount,
        note=payload.note,
        form_extra=payload.form_extra,
        actor=_actor(user),
        user=user,
    )
    item = next(
        item for item in orders_list_order_links(db, order_id, user) if item["id"] == link.id
    )
    return schemas.OrderLinkOut.model_validate(item)


@router.delete("/orders/{order_id}/links/{link_id}", status_code=204, response_model=None)
def delete_order_link(
    order_id: int,
    link_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = update_orders,
) -> None:
    orders_delete_order_link(db, order_id, link_id, actor=_actor(user), user=user)


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
        form_extra_scope=payload.form_extra_scope,
        user=user,
    )
    return _order_output(order)


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
            delivery_mode=payload.delivery_mode,
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


@router.get("/pools/balances", response_model=schemas.PoolBalanceListOut)
def pool_balances_summary(
    db: Session = Depends(get_db),
    _user: CurrentUser = read_finance,
) -> schemas.PoolBalanceListOut:
    """全部可见资金池的余额卡片 + 汇总（一次请求，替代前端逐池 N+1 与本地累加）。"""
    items, totals = pool_balance_summary(db, user=_user)
    return schemas.PoolBalanceListOut(
        items=[schemas.PoolBalanceOut.model_validate(item) for item in items],
        totals=schemas.PoolBalanceTotalsOut.model_validate(totals),
    )


@router.get("/pools/{pool_id}/balance", response_model=schemas.PoolBalanceOut)
def pool_balance(
    pool_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_finance,
) -> schemas.PoolBalanceOut:
    if not _user.can_see_pool(pool_id):
        from app.core.errors import NotFound
        raise NotFound("资金池不存在", details={"pool_id": pool_id})
    return schemas.PoolBalanceOut.model_validate(
        finance_pool_balance(db, pool_id, user=_user)
    )


__all__ = ["router"]
