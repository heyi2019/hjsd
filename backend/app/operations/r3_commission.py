"""分润对账：订单汇总与人员分润明细。"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any
from app.core.security import CurrentUser
from sqlalchemy import case, select
from sqlalchemy.orm import Session
from app.domain.enums import EventType, OrderStatus
from app.domain.trade import (
    Account,
    Order,
    OrderEvent,
    OrderProfitAllocation,
)
from app.domain.users import User

from app.core.money import to_money_or_zero
from app.business.profit_allocation.calculation import effective_distribution
from app.business.profit_allocation.company_settings import get_company_settings
from app.business.profit_allocation.terms import company_rate_for_profit
from ._shared import (
    ZERO,
    _apply_order_scope,
    _validate_date_range,
    cashflow_totals_by_order,
)


def _commission_rows_and_bases(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None, mine: bool = False, all_people: bool = False, order_id: int | None = None,
) -> tuple[list[tuple[OrderProfitAllocation, Order]], dict[int, Decimal]]:
    _validate_date_range(from_date, to_date)
    personal_scope = mine and user is not None
    order_scope = None if all_people or personal_scope else user
    stmt = (
        select(OrderProfitAllocation, Order)
        .join(Order, Order.id == OrderProfitAllocation.order_id)
        .where(Order.status.in_([
            OrderStatus.COMPLETED.value,
            OrderStatus.INSTALLMENT.value,
            OrderStatus.ACTIVE.value,
        ]))
    )
    if from_date is not None:
        stmt = stmt.where(Order.trade_date >= from_date)
    if to_date is not None:
        stmt = stmt.where(Order.trade_date <= to_date)
    if order_id is not None:
        stmt = stmt.where(Order.id == order_id)
    if personal_scope:
        # 只允许查看本人有分润的订单；先取整单分配行统一处理尾差，输出时仍仅保留本人。
        stmt = stmt.where(Order.id.in_(
            select(OrderProfitAllocation.order_id).where(OrderProfitAllocation.user_id == user.id)
        ))
    rows = session.execute(
        _apply_order_scope(stmt, order_scope, session)
    ).all()
    # 利润 = 该订单所有收入 − 所有支出（2026-11-05 用户裁决）。
    # 走报表唯一取数口，与分润弹窗同源：收入含返点记录、支出含分期坏账；
    # 不再由 SELL/BUY 事件单独推导，也不按「是否生成流水」排除有资金走向的事实。
    per_order_profit: dict[int, Decimal] = defaultdict(lambda: ZERO)
    scoped_order_ids = {order.id for _, order in rows}
    if scoped_order_ids:
        for order_id, (income, expense, _buy) in cashflow_totals_by_order(
            session, order_ids=scoped_order_ids
        ).items():
            per_order_profit[order_id] = to_money_or_zero(income - expense)

    allocations_by_order: dict[int, list[OrderProfitAllocation]] = defaultdict(list)
    for allocation, order in rows:
        allocations_by_order[order.id].append(allocation)
    settings = get_company_settings(session)
    orders = {order.id: order for _, order in rows}
    projected_rows = []
    base_by_allocation = {}
    for order_id, allocations in allocations_by_order.items():
        order = orders[order_id]
        profit = per_order_profit[order_id]
        effective_rows, amounts, rates = effective_distribution(allocations, profit, company_rate_for_profit(profit, settings))
        for allocation in effective_rows:
            # 独立的瞬态对象避免对持久化的历史配置造成隐式写入。
            projected_rows.append((OrderProfitAllocation(id=allocation.id, order_id=allocation.order_id, user_id=allocation.user_id, role=allocation.role, allocation_type=allocation.allocation_type, allocation_rate=rates[allocation.id], allocation_amount=amounts[allocation.id]), order))
        base_by_allocation.update(amounts)
    rows = projected_rows
    return rows, base_by_allocation


def personal_commission_total(
    session: Session, *, user: CurrentUser,
    from_date: date | None = None, to_date: date | None = None,
) -> Decimal:
    """本人收益总额，复用整单分润与尾差口径，不装配报表明细。"""
    rows, bases = _commission_rows_and_bases(session, from_date=from_date, to_date=to_date, user=user, mine=True)
    return sum((bases[allocation.id] for allocation, _ in rows if allocation.user_id == user.id), ZERO)


def r3_commission_reconciliation(
    session: Session, *, from_date: date | None = None, to_date: date | None = None,
    user: CurrentUser | None = None, mine: bool = False, all_people: bool = False,
    user_id: int | None = None, order_id: int | None = None,
) -> dict[str, Any]:
    """分润对账：按订单汇总，展开订单查看人员明细。"""
    rows, base_by_allocation = _commission_rows_and_bases(
        session, from_date=from_date, to_date=to_date, user=user, mine=mine, all_people=all_people, order_id=order_id,
    )
    order_ids = {order.id for _, order in rows}
    account_ids = {order.account_id for _, order in rows if order.account_id is not None}
    accounts = {
        account.id: account
        for account in session.scalars(select(Account).where(Account.id.in_(account_ids))).all()
    } if account_ids else {}
    outbound_dates: dict[int, date] = {}
    if order_ids:
        for order_id, occurred_on in session.execute(
            select(OrderEvent.order_id, OrderEvent.occurred_on)
            .join(Order, Order.id == OrderEvent.order_id)
            .where(
                OrderEvent.order_id.in_(order_ids),
                OrderEvent.event_type == EventType.SELL.value,
                OrderEvent.is_posted.is_(True),
            )
            .order_by(
                OrderEvent.order_id,
                case((Order.order_type.in_(("HS", "TH")), None), else_=OrderEvent.occurred_on).desc(),
                OrderEvent.id.desc(),
            )
        ).all():
            outbound_dates.setdefault(order_id, occurred_on)
    if mine and user is not None:
        rows = [row for row in rows if row[0].user_id == user.id]

    # 报表中的历史分润仍属于原人员，即使其账号已停用也须能显示和筛选。
    # 人员选项在 user_id 筛选前收集，使切换人员后仍可选择同一范围内的其他人。
    person_ids = {allocation.user_id for allocation, _ in rows if allocation.user_id is not None}
    people = [
        {"user_id": person.id, "user_name": person.display_name or person.username, "is_active": person.is_active}
        for person in session.scalars(select(User).where(User.id.in_(person_ids)).order_by(User.id)).all()
    ] if person_ids else []
    person_names = {person["user_id"]: person["user_name"] for person in people}
    if user_id is not None:
        rows = [row for row in rows if row[0].user_id == user_id]

    order_grouped: dict[int, dict[str, Any]] = {}
    for allocation, order in rows:
        account = accounts.get(order.account_id)
        # 分润支持「按比例」与「按金额」两种录入口径：填了金额就直接作为应付基数，
        # 否则按 利润 × 比例 计算。二者由录入校验保证不会同时出现。
        # 判据必须是 `!= 0` 而非 `> 0`：亏损单的金额本身就是负数（填 -300 表示分担 300 亏损），
        # 用 `> 0` 会把负数误判成「没填金额」而回退到比例，亏损分润就算错。
        base = base_by_allocation[allocation.id]
        detail = {
            "user_id": allocation.user_id,
            "user_name": "公司" if allocation.user_id is None else person_names.get(allocation.user_id),
            "order_no": order.order_no,
            "order_id": order.id,
            "inventory_date": account.inventory_entry_at.date() if account else None,
            "outbound_date": outbound_dates.get(order.id),
            "allocation_type": allocation.allocation_type,
            "profit_base": base,
            "rate": allocation.allocation_rate,
        }
        group = order_grouped.setdefault(
            order.id,
            {
                "order_id": order.id,
                "order_no": order.order_no,
                "inventory_date": detail["inventory_date"],
                "outbound_date": detail["outbound_date"],
                "profit_base": ZERO,
                "personnel_profit_base": ZERO,
                "orders": [],
            },
        )
        group["profit_base"] += base
        if allocation.user_id is not None:
            group["personnel_profit_base"] += base
        group["orders"].append(detail)

    order_groups = [
        order_grouped[order_id]
        for order_id in sorted(order_grouped)
    ]
    total_profit_base = sum(
        (group["profit_base"] for group in order_groups),
        ZERO,
    )
    return {
        "order_groups": order_groups,
        "people": people,
        "total": {
            "order_count": len(order_groups),
            "profit_base": total_profit_base,
        },
    }


# --------------------------------------------------------------------- 业务损益
