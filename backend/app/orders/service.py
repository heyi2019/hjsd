"""orders.service：订单、业务事件与现金流派生（ORD-01/02、HS/TH/DG/DFQ）。

不可突破的口径：
- 订单汇总、账号成本、分期已收一律**由事件派生**，禁止直接写（ORD-02-02）；
- 一个事件最多派生一条有效现金流；`DELIVER` 无金额、无现金流；
- 资金池优先级：事件显式池 > 业务默认路由 > 阻断 `POOL_ROUTE_MISSING`（ORD-02-04）。
"""
from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.business_numbering import cashflow_no as next_cashflow_no
from app.core.business_numbering import event_no as next_event_no
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.security import CurrentUser, owner_scope_filter, owner_scope_ids
from app.core.money import require_positive, to_money
from app.core.numbering import allocate_number
from app.core.state_machine import ACCOUNT_TRANSITIONS, ORDER_TRANSITIONS, transition
from app.policy import service as policy_service
from app.domain.enums import (
    AccountStatus,
    AuditAction,
    CapitalType,
    Direction,
    EventType,
    Nature,
    OrderStatus,
    PolicyType,
    PoolStatus,
    SequenceKey,
)
from app.domain.foundation import Pool
from app.domain.trade import Account, Cashflow, Order, OrderEvent
from app.foundation import service as foundation_service
from app.parties import service as parties_service

# 事件 → 现金流方向 / 性质 / 分类
EVENT_FLOW_MAP: dict[str, tuple[str, str, str]] = {
    EventType.BUY.value: (Direction.OUT.value, Nature.BUSINESS_OUT.value, "BUY"),
    EventType.COST.value: (Direction.OUT.value, Nature.BUSINESS_OUT.value, "COST"),
    EventType.SELL.value: (Direction.IN.value, Nature.BUSINESS_IN.value, "SELL"),
    EventType.PAYMENT.value: (Direction.IN.value, Nature.BUSINESS_IN.value, "PAYMENT"),
    EventType.CANCEL.value: (Direction.IN.value, Nature.BUSINESS_IN.value, "CANCEL"),
}
MONEY_EVENTS = tuple(EVENT_FLOW_MAP.keys())


# --------------------------------------------------------------------- 订单
def create_order(
    session: Session,
    *,
    order_type: str,
    trade_date: date,
    actor: str,
    account_id: int | None = None,
    owner_id: int | None = None,
    capital_type: str | None = None,
    note: str | None = None,
    customer_roles: Sequence[tuple[int, str]] = (),
    counterparty_roles: Sequence[tuple[int, str]] = (),
) -> Order:
    definition = foundation_service.get_order_type_by_code(session, order_type)
    if definition is None:
        raise Validation(
            f"业务类型 {order_type} 不存在", details={"order_type": order_type}
        )
    if not definition.is_active:
        raise Validation(
            f"业务类型 {order_type} 已停用，禁止新建单",
            code=ErrorCode.ORDER_TYPE_DISABLED,
            details={"order_type": order_type},
        )


    # BAS-06-04 规则快照：按成交日固化当时生效的返点/提成规则。
    # 规则改版不回写这里，历史订单永远按当时口径计算。
    snapshot: dict[str, Any] = {}
    primary_version_id: int | None = None
    for code in (PolicyType.REBATE.value, PolicyType.COMMISSION.value):
        version_id, snap = policy_service.make_snapshot(
            session, policy_code=code, on=trade_date
        )
        if snap is None:
            continue
        snapshot[code] = snap
        # policy_version_id 只存一个主版本（返点优先），完整参数在 policy_snapshot 里
        if primary_version_id is None:
            primary_version_id = version_id

    order = Order(
        order_no=foundation_service.next_order_no(session, definition),
        order_type=definition.code,
        capital_type=capital_type or definition.capital_type,
        trade_date=trade_date,
        account_id=account_id,
        status=OrderStatus.ACTIVE.value,
        policy_version_id=primary_version_id,
        policy_snapshot=snapshot or None,
        owner_id=owner_id,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(order)
    session.flush()

    role_records: list[dict[str, Any]] = []
    for customer_id, role in customer_roles:
        customer = parties_service.assert_customer_usable(session, customer_id)
        role_records.append({"kind": "customer", "id": customer.customer_no, "role": role})
        session.add(
            _customer_role(order.id, customer_id, role)
        )
    for counterparty_id, role in counterparty_roles:
        counterparty = parties_service.assert_counterparty_usable(
            session, counterparty_id, expected_type=role
        )
        role_records.append(
            {"kind": "counterparty", "id": counterparty.counterparty_no, "role": role}
        )
        session.add(_counterparty_role(order.id, counterparty_id, role))
    session.flush()

    record_audit(
        session,
        action=AuditAction.ORDER_CREATE,
        entity_type="order",
        entity_id=order.order_no,
        actor=actor,
        after={"order_type": order.order_type, "status": order.status, "roles": role_records},
    )
    return order


def _customer_role(order_id: int, customer_id: int, role: str):
    from app.domain.parties import OrderCustomerRole

    return OrderCustomerRole(order_id=order_id, customer_id=customer_id, role=role)


def _counterparty_role(order_id: int, counterparty_id: int, role: str):
    from app.domain.parties import OrderCounterpartyRole

    return OrderCounterpartyRole(
        order_id=order_id, counterparty_id=counterparty_id, role=role
    )


def get_order(session: Session, order_id: int, user: CurrentUser | None = None) -> Order:
    order = session.get(Order, order_id)
    if order is None:
        raise NotFound(f"订单 {order_id} 不存在", details={"order_id": order_id})
    if user is not None and user.owner_scope != "ALL" and not user.is_admin:
        visible_ids = owner_scope_ids(session, user)
        if order.owner_id not in (visible_ids or set()):
            raise NotFound(f"订单 {order_id} 不存在", details={"order_id": order_id})
    return order


def list_orders(
    session: Session, *, order_type: str | None = None, status: str | None = None,
    user: CurrentUser | None = None,
) -> list[Order]:
    stmt = select(Order)
    if order_type:
        stmt = stmt.where(Order.order_type == order_type)
    if status:
        stmt = stmt.where(Order.status == status)
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    return list(session.scalars(stmt.order_by(Order.id)).all())


# --------------------------------------------------------------------- 事件
def post_event(
    session: Session,
    order_id: int,
    *,
    event_type: str,
    amount: Any = 0,
    occurred_on: date,
    actor: str,
    pool_id: int | None = None,
    portion: str = "PRINCIPAL",
    delivery_mode: str | None = None,
    offset_event_id: int | None = None,
    reason: str | None = None,
    flow_category: str | None = None,
    note: str | None = None,
) -> tuple[OrderEvent, Cashflow | None]:
    """过账：状态校验 → 池路由 → 事件落库 → 现金流派生 → 账号/订单状态，同一事务。"""
    try:
        EventType(event_type)
    except ValueError as exc:
        raise Validation(
            f"事件类型必须为 {EventType.values()}",
            details={"field": "event_type", "value": event_type},
        ) from exc

    order = get_order(session, order_id)
    if order.status != OrderStatus.ACTIVE.value:
        raise Conflict(
            f"订单 {order.order_no} 当前状态 {order.status}，不能登记事件",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"order_no": order.order_no, "current_status": order.status},
        )

    if event_type == EventType.DELIVER.value:
        return _post_deliver(
            session,
            order,
            occurred_on=occurred_on,
            actor=actor,
            delivery_mode=delivery_mode,
            note=note,
        )

    if event_type not in MONEY_EVENTS:
        raise Validation(
            f"{event_type} 不是可过账的金额事件", details={"event_type": event_type}
        )

    if event_type == EventType.SELL.value:
        _assert_sellable_order(session, order)

    money = require_positive(amount, field="amount")
    resolved_pool_id = pool_id or _resolve_pool(session, order, portion).id
    _assert_pool_active(session, resolved_pool_id)
    event = OrderEvent(
        event_no=next_event_no(
            session, order_no=order.order_no, order_id=order.id, event_type=event_type
        ),
        order_id=order.id,
        event_type=event_type,
        amount=money,
        portion=portion,
        occurred_on=occurred_on,
        pool_id=resolved_pool_id,
        offset_event_id=offset_event_id,
        reason=reason,
        note=note,
        is_posted=True,
        created_by=actor,
        updated_by=actor,
    )
    session.add(event)
    session.flush()

    direction, nature, category = EVENT_FLOW_MAP[event_type]
    if flow_category is not None:
        if event_type != EventType.COST.value or flow_category not in {"FEE", "DESIGN", "OTHER"}:
            raise Validation(
                "仅 COST 事件可使用 FEE、DESIGN 或 OTHER 资金分类",
                details={"event_type": event_type, "flow_category": flow_category},
            )
        category = flow_category
    if event_type == EventType.CANCEL.value:
        direction = _opposite_direction(offset_event_id, session)

    flow = Cashflow(
        flow_no=next_cashflow_no(
            session, order_no=order.order_no, order_id=order.id, category=category
        ),
        pool_id=event.pool_id,
        occurred_on=occurred_on,
        nature=nature,
        category=category,
        direction=direction,
        amount=money,
        order_event_id=event.id,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(flow)

    _apply_account_effect(session, order, event_type, money)
    if event_type == EventType.CANCEL.value:
        # 冲销事件闭环：订单进入 CANCELLED，此后不再接受任何新事件
        order.status = transition(
            ORDER_TRANSITIONS, order.status, "CANCEL", entity="订单"
        )
    session.flush()

    record_audit(
        session,
        action=AuditAction.EVENT_POST,
        entity_type="order_event",
        entity_id=event.event_no,
        actor=actor,
        after={
            "order_no": order.order_no,
            "event_type": event_type,
            "amount": str(money),
            "pool_id": event.pool_id,
            "flow_no": flow.flow_no,
        },
        reason=reason,
    )
    return event, flow


def _assert_sellable_order(session: Session, order: Order) -> None:
    """库存账号售出必须建立在已采购入库之上。"""
    if order.order_type != "HS":
        return
    if order.account_id is None:
        raise Validation(
            "自营账号售出必须关联已回收账号",
            details={"order_type": order.order_type, "account_id": None},
        )

    account = session.get(Account, order.account_id)
    if account is None:
        raise NotFound(f"账号 {order.account_id} 不存在", details={"account_id": order.account_id})
    if account.status not in (AccountStatus.IN_STOCK.value, AccountStatus.FOR_SALE.value):
        raise Validation(
            "账号必须先完成回收并进入库存后才能售出",
            details={"account_status": account.status, "account_id": account.id},
        )

    purchased = session.scalar(
        select(OrderEvent.id)
        .join(Order, Order.id == OrderEvent.order_id)
        .where(
            Order.account_id == account.id,
            OrderEvent.event_type == EventType.BUY.value,
            OrderEvent.is_posted.is_(True),
        )
        .limit(1)
    )
    if purchased is None:
        raise Validation(
            "账号缺少已过账的采购入库记录，不能售出",
            details={"account_id": account.id},
        )


def _opposite_direction(offset_event_id: int | None, session: Session) -> str:
    if offset_event_id is None:
        return Direction.IN.value
    offset = session.get(OrderEvent, offset_event_id)
    if offset is None:
        raise NotFound(
            f"被冲销事件 {offset_event_id} 不存在",
            details={"offset_event_id": offset_event_id},
        )
    return Direction.IN.value if offset.event_type == EventType.BUY.value else Direction.OUT.value


def _post_deliver(
    session: Session,
    order: Order,
    *,
    occurred_on: date,
    actor: str,
    delivery_mode: str | None,
    note: str | None,
) -> tuple[OrderEvent, None]:
    """`DELIVER`：无金额、无现金流，必须记录交付方式与凭证（DFQ-01-07 / A04 / A05）。"""
    modes = ("PLATFORM_OPERATOR", "CUSTOMER_SELF")
    if delivery_mode not in modes:
        raise Validation(
            f"DELIVER 必须提供 delivery_mode，取值 {modes}",
            code=ErrorCode.DELIVERY_CONDITION_UNMET,
            details={"field": "delivery_mode", "value": delivery_mode},
        )
    if not note:
        raise Validation(
            "DELIVER 必须记录交付凭证说明",
            code=ErrorCode.DELIVERY_CONDITION_UNMET,
            details={"field": "note"},
        )
    event = OrderEvent(
        event_no=next_event_no(
            session,
            order_no=order.order_no,
            order_id=order.id,
            event_type=EventType.DELIVER.value,
        ),
        order_id=order.id,
        event_type=EventType.DELIVER.value,
        amount=Decimal("0"),
        occurred_on=occurred_on,
        pool_id=None,
        delivery_mode=delivery_mode,
        is_posted=True,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(event)
    if order.account_id is not None:
        account = session.get(Account, order.account_id)
        if account is not None:
            account.status = AccountStatus.SOLD.value
    order.status = transition(
        ORDER_TRANSITIONS, order.status, "COMPLETE", entity="订单"
    )
    session.flush()
    record_audit(
        session,
        action=AuditAction.DELIVER_CREATE,
        entity_type="order_event",
        entity_id=event.event_no,
        actor=actor,
        after={"order_no": order.order_no, "delivery_mode": delivery_mode},
    )
    return event, None


def _resolve_pool(session: Session, order: Order, portion: str) -> Pool:
    pool = foundation_service.resolve_default_pool(session, order.order_type, portion)
    if pool is None:
        raise Validation(
            f"业务 {order.order_type} 未配置 {portion} 资金池路由",
            code=ErrorCode.POOL_ROUTE_MISSING,
            details={"order_type": order.order_type, "portion": portion},
        )
    return pool


def _assert_pool_active(session: Session, pool_id: int) -> Pool:
    """停用池不得用于新记录（QLT-01-04：主数据一致性校验）。"""
    pool = session.get(Pool, pool_id)
    if pool is None:
        raise NotFound(f"资金池 {pool_id} 不存在", details={"pool_id": pool_id})
    if pool.status != PoolStatus.ACTIVE.value:
        raise Validation(
            f"资金池 {pool.code} 已停用，不能登记新流水",
            code=ErrorCode.POOL_DISABLED,
            details={"pool_code": pool.code, "status": pool.status},
        )
    return pool


def _apply_account_effect(
    session: Session, order: Order, event_type: str, amount: Decimal
) -> None:
    """账号状态与成本只由事件驱动（ACC-01-03/04）。"""
    if order.account_id is None:
        return
    account = session.get(Account, order.account_id)
    if account is None:
        return
    # HS 与 TH 都会把账号带入库存；TH 仍保持 PASS_THRU 资金口径，
    # 这里只单独决定账号状态，不改变订单的资金核算类型。
    stock_type = order.order_type in ("HS", "TH") or order.capital_type == CapitalType.STOCK.value
    credit_type = order.capital_type == CapitalType.CREDIT.value

    if event_type == EventType.BUY.value:
        account.cost_amount = to_money(account.cost_amount) + amount
        account.buy_date = order.trade_date
        account.status = transition(
            ACCOUNT_TRANSITIONS,
            account.status,
            "BUY_STOCK" if stock_type else "BUY_CREDIT",
            entity="账号",
        )
    elif event_type == EventType.COST.value:
        account.cost_amount = to_money(account.cost_amount) + amount
    elif event_type == EventType.SELL.value:
        account.status = transition(ACCOUNT_TRANSITIONS, account.status, "SELL", entity="账号")
    elif event_type == EventType.CANCEL.value:
        account.cost_amount = to_money(account.cost_amount) - amount
        account.status = transition(ACCOUNT_TRANSITIONS, account.status, "VOID", entity="账号")


# --------------------------------------------------------------------- 池余额
def pool_balance(session: Session, pool_id: int) -> dict[str, Any]:
    """资金池卡片：现金余额、押金占用与可用余额。"""
    pool = session.get(Pool, pool_id)
    if pool is None:
        raise NotFound(f"资金池 {pool_id} 不存在", details={"pool_id": pool_id})

    def total(direction: str, nature: str | None = None) -> Decimal:
        stmt = select(func.coalesce(func.sum(Cashflow.amount), 0)).where(
            Cashflow.pool_id == pool_id, Cashflow.direction == direction
        )
        if nature:
            stmt = stmt.where(Cashflow.nature == nature)
        return to_money(session.scalar(stmt) or 0)

    income = total(Direction.IN.value, Nature.BUSINESS_IN.value)
    expense = total(Direction.OUT.value, Nature.BUSINESS_OUT.value)
    cash_balance = income - expense

    deposit_held = _deposit_held(session, pool_id)
    return {
        "pool_id": pool.id,
        "pool_code": pool.code,
        "income": income,
        "expense": expense,
        "cash_balance": cash_balance,
        "deposit_held": deposit_held,
        "available": cash_balance - deposit_held,
    }


def _deposit_held(session: Session, pool_id: int) -> Decimal:
    from app.domain.trade import Deposit

    stmt = select(func.coalesce(func.sum(Deposit.paid_amount - Deposit.returned_amount), 0)).where(
        Deposit.pool_id == pool_id
    )
    return to_money(session.scalar(stmt) or 0)


__all__ = [
    "create_order",
    "get_order",
    "list_orders",
    "pool_balance",
    "post_event",
    "transfer",
]
