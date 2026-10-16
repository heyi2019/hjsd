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
    rows = session.execute(
        _apply_order_scope(
            select(OrderEvent.order_id, func.sum(OrderEvent.amount))
            .join(Order, Order.id == OrderEvent.order_id)
            .where(
                OrderEvent.event_type.in_([EventType.BUY.value, EventType.COST.value])
            ),
            user,
            session,
        ).group_by(OrderEvent.order_id)
    ).all()
    for order_id, amount in rows:
        order_cost[order_id] += _money(amount)

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
            expected_price += _money(
                session.scalar(
                    select(func.coalesce(func.sum(OrderEvent.amount), 0)).where(
                        OrderEvent.order_id == order.id,
                        OrderEvent.event_type == EventType.SELL.value,
                    )
                )
            )
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
                "risk_level": account.risk_level,
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
    events = session.execute(
        _apply_order_scope(
            select(
                OrderEvent.event_type,
                OrderEvent.occurred_on,
                OrderEvent.amount,
                Order.order_type,
                Order.capital_type,
            )
            .join(Order, Order.id == OrderEvent.order_id)
            .where(OrderEvent.is_posted.is_(True)),
            user,
            session,
        )
    ).all()

    revenue: dict[str, Decimal] = defaultdict(lambda: ZERO)
    direct_cost: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for event_type, occurred_on, amount, _order_type, capital_type in events:
        if from_date and occurred_on < from_date:
            continue
        if to_date and occurred_on > to_date:
            continue
        key = _month_key(occurred_on)
        if event_type == EventType.SELL.value:
            revenue[key] += _money(amount)
        elif event_type in (EventType.BUY.value, EventType.COST.value):
            direct_cost[key] += _money(amount)

    # 运营费用 = 非订单来源的业务支出流水（账号 COST 走事件，不在此列）
    op_stmt = select(Cashflow.occurred_on, Cashflow.amount).where(
        Cashflow.nature == Nature.BUSINESS_OUT.value,
        Cashflow.order_event_id.is_(None),
    )
    pool_ids = _visible_pool_ids(user)
    if pool_ids is not None:
        op_stmt = op_stmt.where(Cashflow.pool_id.in_(pool_ids))
    op_rows = session.execute(op_stmt).all()
    operating: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for occurred_on, amount in op_rows:
        if from_date and occurred_on < from_date:
            continue
        if to_date and occurred_on > to_date:
            continue
        operating[_month_key(occurred_on)] += _money(amount)

    rebate_stmt = (
        select(
            RebateSettlement.settled_on,
            RebateSettlement.gross_amount,
            RebateSettlement.platform_fee,
        )
        .join(RebateRecord, RebateRecord.id == RebateSettlement.rebate_record_id)
        .join(Order, Order.id == RebateRecord.source_order_id)
    )
    rebate_stmt = _apply_order_scope(rebate_stmt, user, session)
    rebate_rows = session.execute(rebate_stmt).all()
    rebate_net: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for settled_on, gross, fee in rebate_rows:
        if from_date and settled_on < from_date:
            continue
        if to_date and settled_on > to_date:
            continue
        rebate_net[_month_key(settled_on)] += _money(gross) - _money(fee)

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
    events = session.execute(
        _apply_order_scope(
            select(OrderEvent.order_id, OrderEvent.event_type, OrderEvent.amount)
            .join(Order, Order.id == OrderEvent.order_id)
            .where(OrderEvent.is_posted.is_(True)),
            user,
            session,
        )
    ).all()
    for order_id, event_type, amount in events:
        if event_type == EventType.SELL.value:
            per_order_profit[order_id] += _money(amount)
        elif event_type in (EventType.BUY.value, EventType.COST.value):
            per_order_profit[order_id] -= _money(amount)

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
            select(
                Order.order_type,
                OrderEvent.event_type,
                OrderEvent.amount,
                OrderEvent.occurred_on,
            )
            .join(OrderEvent, OrderEvent.order_id == Order.id)
            .where(OrderEvent.is_posted.is_(True)),
            user,
            session,
        )
    ).all()

    revenue: dict[str, Decimal] = defaultdict(lambda: ZERO)
    cost: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for order_type, event_type, amount, occurred_on in rows:
        if from_date and occurred_on < from_date:
            continue
        if to_date and occurred_on > to_date:
            continue
        if event_type == EventType.SELL.value:
            revenue[order_type] += _money(amount)
        elif event_type in (EventType.BUY.value, EventType.COST.value):
            cost[order_type] += _money(amount)

    settled: dict[str, Decimal] = defaultdict(lambda: ZERO)
    unsettled: dict[str, Decimal] = defaultdict(lambda: ZERO)
    rebate_stmt = (
        select(RebateRecord, RebateSettlement.gross_amount, RebateSettlement.platform_fee, Order.order_type)
        .outerjoin(RebateSettlement, RebateSettlement.rebate_record_id == RebateRecord.id)
        .outerjoin(Order, Order.id == RebateRecord.source_order_id)
    )
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            rebate_stmt = rebate_stmt.where(
                (RebateRecord.source_order_id.is_(None)) | scope
            )
    rebates = session.execute(rebate_stmt).all()
    for record, gross, fee, order_type in rebates:
        bucket = order_type or "UNCOLLECTED"
        if gross is None:
            # 尚未结算：按基数 × 费率计“未归集”，独立列示不摊给业务
            unsettled[bucket] += (
                _money(record.base_amount) * _money(record.rate) / Decimal("100")
            ).quantize(Decimal("0.01"))
        else:
            settled[bucket] += _money(gross) - _money(fee)

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
                ).where(Cashflow.pool_id == pool.id, Cashflow.occurred_on < target)
            )
        )
        day_in = _money(
            session.scalar(
                select(func.coalesce(func.sum(Cashflow.amount), 0)).where(
                    Cashflow.pool_id == pool.id,
                    Cashflow.occurred_on == target,
                    Cashflow.direction == Direction.IN.value,
                    Cashflow.nature == Nature.BUSINESS_IN.value,
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
        income = ZERO
        buy = ZERO
        direct_cost = ZERO
        events = session.scalars(
            select(OrderEvent).where(OrderEvent.order_id == order.id)
        ).all()
        for event in events:
            amount = _money(event.amount)
            if event.event_type == EventType.SELL.value:
                income += amount
            elif event.event_type == EventType.BUY.value:
                buy += amount
            elif event.event_type == EventType.COST.value:
                direct_cost += amount
        rebate = ZERO
        settlements = session.execute(
            select(RebateSettlement.gross_amount, RebateSettlement.platform_fee)
            .join(RebateRecord, RebateRecord.id == RebateSettlement.rebate_record_id)
            .where(RebateRecord.source_order_id == order.id)
        ).all()
        for gross, fee in settlements:
            rebate += _money(gross) - _money(fee)
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
