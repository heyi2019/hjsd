"""reporting.service：R1 库存健康 / R2 月度经营损益 / R3 提成对账 / R5 业务级损益
+ 资金日报 / 订单利润明细（RPT-01）。

口径红线：
- 账号 COST 属直接成本，**不进运营费用**（R2 验收「作图费不会使运营费用重复增加」）。
- 未归集返点**独立成列，不摊给业务**（R5）。
- 回收与提号账号统一纳入库存（R1）。
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.core.security import CurrentUser, owner_scope_filter
from app.domain.enums import (
    AccountStatus,
    CashflowStatus,
    Direction,
    EventType,
    Nature,
    OrderStatus,
    RebateStatus,
)
from app.domain.foundation import Pool
from app.domain.trade import (
    Account,
    Cashflow,
    Deposit,
    Order,
    OrderEvent,
    OrderProfitAllocation,
    RebateRecord,
    RebateSettlement,
)

ZERO = Decimal("0")


def _money(value: Any) -> Decimal:
    return to_money(value or 0)


def _event_contribution(
    event: OrderEvent, event_types: dict[int, str]
) -> tuple[Decimal, Decimal, Decimal]:
    """Return (income, buy_amount, direct_cost) for one posted event.

    CANCEL is an accounting reversal only when it explicitly points at the
    event it offsets.  A bare order cancellation changes workflow state, but
    does not provide enough information to rewrite historical P&L.
    """
    amount = _money(event.amount)
    if event.event_type == EventType.SELL.value:
        return amount, ZERO, ZERO
    if event.event_type == EventType.BUY.value:
        return ZERO, amount, ZERO
    if event.event_type == EventType.COST.value:
        return ZERO, ZERO, amount
    if event.event_type == EventType.CANCEL.value and event.offset_event_id is not None:
        offset_type = event_types.get(event.offset_event_id)
        if offset_type == EventType.SELL.value:
            return -amount, ZERO, ZERO
        if offset_type == EventType.BUY.value:
            return ZERO, -amount, ZERO
        if offset_type == EventType.COST.value:
            return ZERO, ZERO, -amount
    return ZERO, ZERO, ZERO


def _event_totals(
    events: list[OrderEvent], *, from_date: date | None = None, to_date: date | None = None
) -> tuple[Decimal, Decimal, Decimal]:
    event_types = {event.id: event.event_type for event in events}
    income = ZERO
    buy_amount = ZERO
    direct_cost = ZERO
    for event in events:
        if not event.is_posted:
            continue
        if from_date and event.occurred_on < from_date:
            continue
        if to_date and event.occurred_on > to_date:
            continue
        event_income, event_buy, event_cost = _event_contribution(event, event_types)
        income += event_income
        buy_amount += event_buy
        direct_cost += event_cost
    return income, buy_amount, direct_cost


def _month_key(value: date) -> str:
    return f"{value.year:04d}-{value.month:02d}"


def _apply_order_scope(stmt, user: CurrentUser | None, session: Session):
    if user is None:
        return stmt
    scope = owner_scope_filter(Order.owner_id, user, session)
    return stmt.where(scope) if scope is not None else stmt


def _visible_pool_ids(user: CurrentUser | None) -> set[int] | None:
    if user is None or user.is_admin or user.owner_scope == "ALL":
        return None
    return set(user.pool_ids)


# --------------------------------------------------------------------- R1 库存
def r1_inventory_health(
    session: Session, *, user: CurrentUser | None = None
) -> dict[str, Any]:
    """R1 库存健康表：统计已采购并处于在库、待售或分期状态的账号。"""
    today = date.today()
    stock_statuses = [
        AccountStatus.IN_STOCK.value,
        AccountStatus.INSTALLMENT.value,
        AccountStatus.FOR_SALE.value,
    ]

    order_cost: dict[int, Decimal] = defaultdict(lambda: ZERO)
    order_income: dict[int, Decimal] = defaultdict(lambda: ZERO)
    event_rows = session.scalars(
        _apply_order_scope(
            select(OrderEvent)
            .join(Order, Order.id == OrderEvent.order_id)
            .where(OrderEvent.is_posted.is_(True)),
            user,
            session,
        )
    ).all()
    events_by_order: dict[int, list[OrderEvent]] = defaultdict(list)
    for event in event_rows:
        events_by_order[event.order_id].append(event)
    for order_id, events in events_by_order.items():
        income, buy_amount, direct_cost = _event_totals(events)
        order_income[order_id] = income
        order_cost[order_id] = buy_amount + direct_cost

    active_stmt = select(Order).where(Order.status == OrderStatus.ACTIVE.value)
    active_stmt = _apply_order_scope(active_stmt, user, session)
    active = session.scalars(active_stmt).all()
    order_by_account: dict[int, list[Order]] = defaultdict(list)
    for order in active:
        if order.account_id is not None:
            order_by_account[order.account_id].append(order)

    items = []
    account_stmt = select(Account)
    if user is not None and not user.is_admin and user.owner_scope != "ALL":
        visible_order_ids = select(Order.account_id).where(Order.account_id.is_not(None))
        visible_order_ids = _apply_order_scope(visible_order_ids, user, session)
        account_stmt = account_stmt.where(
            (Account.created_by == user.username) | Account.id.in_(visible_order_ids)
        )
    accounts = session.scalars(account_stmt).all()
    for account in accounts:
        if account.status not in stock_statuses:
            continue
        orders = order_by_account.get(account.id, [])
        holding_days = (
            (today - account.buy_date).days if account.buy_date else None
        )
        expected_price = ZERO
        for order in orders:
            expected_price += order_income[order.id]
        total_cost = _money(account.cost_amount)
        items.append(
            {
                "inventory_no": account.inventory_no,
                "game_account": account.game_account,
                "platform": account.platform,
                "business": ",".join({o.order_type for o in orders}) or None,
                "status": account.status,
                "buy_amount": total_cost,
                "extra_cost": max(
                    ZERO, sum((order_cost[o.id] for o in orders), ZERO) - total_cost
                ),
                "total_cost": total_cost,
                "holding_days": holding_days,
                "expected_price": expected_price,
                "expected_profit": expected_price - total_cost,
                "owner_id": orders[0].owner_id if orders else None,
            }
        )
    return {"generated_on": today.isoformat(), "items": items, "total": len(items)}


# --------------------------------------------------------------------- R2 月度
def r2_monthly_pnl(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """R2 月度经营损益：账号 COST 归直接成本，不进运营费用。"""
    events = session.scalars(
        _apply_order_scope(
            select(OrderEvent)
            .join(Order, Order.id == OrderEvent.order_id)
            .where(OrderEvent.is_posted.is_(True)),
            user,
            session,
        )
    ).all()

    revenue: dict[str, Decimal] = defaultdict(lambda: ZERO)
    direct_cost: dict[str, Decimal] = defaultdict(lambda: ZERO)
    event_types = {event.id: event.event_type for event in events}
    for event in events:
        if from_date and event.occurred_on < from_date:
            continue
        if to_date and event.occurred_on > to_date:
            continue
        key = _month_key(event.occurred_on)
        income, buy_amount, event_cost = _event_contribution(event, event_types)
        revenue[key] += income
        direct_cost[key] += buy_amount + event_cost

    # 运营费用 = 非订单来源的已审核业务支出流水；返点、押金、划转不重复计入。
    op_stmt = select(Cashflow).where(
        Cashflow.status == CashflowStatus.APPROVED.value,
        Cashflow.order_event_id.is_(None),
        Cashflow.category.notin_(
            {
                "REBATE",
                "REBATE_REVERSAL",
                "DEPOSIT_HOLD",
                "DEPOSIT_RELEASE",
                "TRANSFER",
            }
        ),
    )
    pool_ids = _visible_pool_ids(user)
    if pool_ids is not None:
        op_stmt = op_stmt.where(Cashflow.pool_id.in_(pool_ids))
    op_rows = session.scalars(op_stmt).all()
    operating: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for flow in op_rows:
        occurred_on = flow.occurred_on
        if from_date and occurred_on < from_date:
            continue
        if to_date and occurred_on > to_date:
            continue
        amount = _money(flow.amount)
        if (
            flow.direction == Direction.OUT.value
            and flow.nature == Nature.BUSINESS_OUT.value
        ):
            operating[_month_key(occurred_on)] += amount
        elif flow.reversal_of_id is not None:
            original = session.get(Cashflow, flow.reversal_of_id)
            if original is not None and (
                original.direction == Direction.OUT.value
                and original.nature == Nature.BUSINESS_OUT.value
            ):
                operating[_month_key(occurred_on)] -= amount

    rebate_stmt = (
        select(
            RebateSettlement.settled_on,
            RebateSettlement.gross_amount,
            RebateSettlement.platform_fee,
            RebateSettlement.reversal_of_id,
        )
        .join(RebateRecord, RebateRecord.id == RebateSettlement.rebate_record_id)
        .join(Order, Order.id == RebateRecord.source_order_id)
    )
    rebate_stmt = _apply_order_scope(rebate_stmt, user, session)
    rebate_rows = session.execute(rebate_stmt).all()
    rebate_net: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for settled_on, gross, fee, reversal_of_id in rebate_rows:
        if from_date and settled_on < from_date:
            continue
        if to_date and settled_on > to_date:
            continue
        sign = Decimal("-1") if reversal_of_id is not None else Decimal("1")
        rebate_net[_month_key(settled_on)] += sign * (_money(gross) - _money(fee))

    for bucket in (revenue, direct_cost, operating, rebate_net):
        for month in list(bucket):
            if bucket[month] == ZERO:
                del bucket[month]
    months = sorted(set(revenue) | set(direct_cost) | set(operating) | set(rebate_net))
    items = []
    for month in months:
        income = revenue[month]
        cost = direct_cost[month]
        op = operating[month]
        rebate = rebate_net[month]
        items.append(
            {
                "month": month,
                "sales_income": income,
                "account_direct_cost": cost,
                "operating_expense": op,
                "rebate_net": rebate,
                "operating_profit": income - cost - op + rebate,
            }
        )
    return {"items": items, "total": len(items)}


# --------------------------------------------------------------------- R3 提成
def r3_commission_reconciliation(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """R3 提成对账：按人员钻取到单；无规则版本时提成率为 0（不臆造）。"""
    rows = session.execute(
        _apply_order_scope(
            select(OrderProfitAllocation, Order)
            .join(Order, Order.id == OrderProfitAllocation.order_id)
            .where(Order.status.in_([OrderStatus.COMPLETED.value, OrderStatus.ACTIVE.value])),
            user,
            session,
        )
    ).all()

    per_order_profit: dict[int, Decimal] = defaultdict(lambda: ZERO)
    events = session.scalars(
        _apply_order_scope(
            select(OrderEvent)
            .join(Order, Order.id == OrderEvent.order_id)
            .where(OrderEvent.is_posted.is_(True)),
            user,
            session,
        )
    ).all()
    events_by_order: dict[int, list[OrderEvent]] = defaultdict(list)
    for event in events:
        events_by_order[event.order_id].append(event)
    for order_id, order_events in events_by_order.items():
        income, buy_amount, direct_cost = _event_totals(order_events)
        per_order_profit[order_id] = income - buy_amount - direct_cost

    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for allocation, order in rows:
        if from_date and order.trade_date < from_date:
            continue
        if to_date and order.trade_date > to_date:
            continue
        profit = per_order_profit[order.id]
        rate = _money(allocation.allocation_rate)
        base = (profit * rate / Decimal("100")).quantize(Decimal("0.01"))
        grouped[allocation.user_id].append(
            {
                "order_no": order.order_no,
                "order_id": order.id,
                "profit_base": base,
                "rate": allocation.allocation_rate,
                "payable": ZERO,
                "paid": ZERO,
                "difference": ZERO,
            }
        )

    items = []
    for user_id, orders in sorted(grouped.items()):
        base_total = sum((o["profit_base"] for o in orders), ZERO)
        items.append(
            {
                "user_id": user_id,
                "order_count": len(orders),
                "profit_base": base_total,
                "payable": ZERO,
                "paid": ZERO,
                "difference": ZERO,
                "orders": orders,
            }
        )
    return {"items": items, "total": len(items)}


# --------------------------------------------------------------------- R5 业务
def r5_business_pnl(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """R5 业务级损益：未归集返点独立列，不摊给业务。"""
    rows = session.execute(
        _apply_order_scope(
            select(Order, OrderEvent)
            .join(OrderEvent, OrderEvent.order_id == Order.id)
            .where(OrderEvent.is_posted.is_(True)),
            user,
            session,
        )
    ).all()

    revenue: dict[str, Decimal] = defaultdict(lambda: ZERO)
    cost: dict[str, Decimal] = defaultdict(lambda: ZERO)
    events_by_order: dict[int, list[OrderEvent]] = defaultdict(list)
    order_types: dict[int, str] = {}
    for order, event in rows:
        events_by_order[order.id].append(event)
        order_types[order.id] = order.order_type
    for order_id, order_events in events_by_order.items():
        order_type = order_types[order_id]
        income, buy_amount, direct_cost = _event_totals(
            order_events, from_date=from_date, to_date=to_date
        )
        revenue[order_type] += income
        cost[order_type] += buy_amount + direct_cost

    settled: dict[str, Decimal] = defaultdict(lambda: ZERO)
    unsettled: dict[str, Decimal] = defaultdict(lambda: ZERO)
    rebate_stmt = (
        select(
            RebateRecord,
            RebateSettlement.gross_amount,
            RebateSettlement.platform_fee,
            RebateSettlement.reversal_of_id,
            Order.order_type,
        )
        .outerjoin(RebateSettlement, RebateSettlement.rebate_record_id == RebateRecord.id)
        .outerjoin(Order, Order.id == RebateRecord.source_order_id)
    )
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            rebate_stmt = rebate_stmt.where(
                RebateRecord.source_order_id.is_not(None),
                scope,
            )
    rebates = session.execute(rebate_stmt).all()
    rebate_totals: dict[int, tuple[RebateRecord, str | None, Decimal, Decimal]] = {}
    for record, gross, fee, reversal_of_id, order_type in rebates:
        previous = rebate_totals.get(record.id)
        if previous is None:
            rebate_totals[record.id] = (
                record,
                order_type,
                ZERO,
                ZERO,
            )
            previous = rebate_totals[record.id]
        if gross is not None:
            sign = Decimal("-1") if reversal_of_id is not None else Decimal("1")
            rebate_totals[record.id] = (
                previous[0],
                previous[1],
                previous[2] + sign * _money(gross),
                previous[3] + sign * _money(fee),
            )

    for record, order_type, settled_gross, settled_fee in rebate_totals.values():
        bucket = order_type or "UNCOLLECTED"
        expected = (
            _money(record.base_amount) * _money(record.rate) / Decimal("100")
        ).quantize(Decimal("0.01"))
        settled[bucket] += settled_gross - settled_fee
        # 分次结算只减少剩余未归集金额；没有结算记录时即为全部应收返点。
        unsettled[bucket] += max(ZERO, expected - settled_gross)

    items = []
    for order_type in sorted(set(revenue) | set(cost) | set(settled) | set(unsettled)):
        income = revenue[order_type]
        direct = cost[order_type]
        gross_profit = income - direct
        items.append(
            {
                "order_type": order_type,
                "main_income": income,
                "main_cost": direct,
                "main_profit": gross_profit,
                "settled_rebate": settled[order_type],
                "uncollected_rebate": unsettled[order_type],
                "full_income": gross_profit + settled[order_type],
            }
        )
    return {"items": items, "total": len(items)}


# --------------------------------------------------------------------- 资金日报
def daily_funds_report(
    session: Session, *, on: date | None = None, user: CurrentUser | None = None
) -> dict[str, Any]:
    """资金日报：各池期初/收入/支出/押金/可用余额。"""
    from app.orders.service import pool_balance

    target = on or date.today()
    items = []
    pool_stmt = select(Pool)
    pool_ids = _visible_pool_ids(user)
    if pool_ids is not None:
        pool_stmt = pool_stmt.where(Pool.id.in_(pool_ids))
    for pool in session.scalars(pool_stmt).all():
        opening = _money(
            session.scalar(
                select(
                    func.coalesce(
                        func.sum(
                            case(
                                (Cashflow.direction == Direction.IN.value, Cashflow.amount),
                                else_=-Cashflow.amount,
                            )
                        ),
                        0,
                    )
                ).where(
                    Cashflow.pool_id == pool.id,
                    Cashflow.occurred_on < target,
                    Cashflow.status == CashflowStatus.APPROVED.value,
                )
            )
        )
        day_in = _money(
            session.scalar(
                select(func.coalesce(func.sum(Cashflow.amount), 0)).where(
                    Cashflow.pool_id == pool.id,
                    Cashflow.occurred_on == target,
                    Cashflow.direction == Direction.IN.value,
                    Cashflow.nature == Nature.BUSINESS_IN.value,
                    Cashflow.status == CashflowStatus.APPROVED.value,
                )
            )
        )
        day_out = _money(
            session.scalar(
                select(func.coalesce(func.sum(Cashflow.amount), 0)).where(
                    Cashflow.pool_id == pool.id,
                    Cashflow.occurred_on == target,
                    Cashflow.direction == Direction.OUT.value,
                    Cashflow.nature == Nature.BUSINESS_OUT.value,
                    Cashflow.status == CashflowStatus.APPROVED.value,
                )
            )
        )
        deposit_paid = _money(
            session.scalar(
                select(func.coalesce(func.sum(Deposit.paid_amount), 0)).where(
                    Deposit.pool_id == pool.id, Deposit.paid_on == target
                )
            )
        )
        balance = pool_balance(session, pool.id)
        items.append(
            {
                "pool_code": pool.code,
                "pool_name": pool.name,
                "opening": opening,
                "income": day_in,
                "expense": day_out,
                "deposit_paid": deposit_paid,
                "deposit_held": balance["deposit_held"],
                "cash_balance": balance["cash_balance"],
                "available": balance["available"],
            }
        )
    return {"date": target.isoformat(), "items": items, "total": len(items)}


# --------------------------------------------------------------------- 订单利润
def order_profit_detail(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """订单利润明细：合计与 R5 对应维度一致，可导出但不改原始数据。"""
    orders_stmt = _apply_order_scope(select(Order), user, session)
    orders = session.scalars(orders_stmt).all()
    items = []
    for order in orders:
        if from_date and order.trade_date < from_date:
            continue
        if to_date and order.trade_date > to_date:
            continue
        events = session.scalars(
            select(OrderEvent).where(OrderEvent.order_id == order.id)
        ).all()
        income, buy, direct_cost = _event_totals(events)
        rebate = ZERO
        settlements = session.execute(
            select(
                RebateSettlement.gross_amount,
                RebateSettlement.platform_fee,
                RebateSettlement.reversal_of_id,
            )
            .join(RebateRecord, RebateRecord.id == RebateSettlement.rebate_record_id)
            .where(RebateRecord.source_order_id == order.id)
        ).all()
        for gross, fee, reversal_of_id in settlements:
            sign = Decimal("-1") if reversal_of_id is not None else Decimal("1")
            rebate += sign * (_money(gross) - _money(fee))
        items.append(
            {
                "order_no": order.order_no,
                "order_id": order.id,
                "order_type": order.order_type,
                "trade_date": order.trade_date.isoformat(),
                "status": order.status,
                "income": income,
                "buy_amount": buy,
                "direct_cost": direct_cost,
                "rebate": rebate,
                "net_profit": income - buy - direct_cost + rebate,
            }
        )
    return {"items": items, "total": len(items)}


__all__ = [
    "daily_funds_report",
    "order_profit_detail",
    "r1_inventory_health",
    "r2_monthly_pnl",
    "r3_commission_reconciliation",
    "r5_business_pnl",
]
