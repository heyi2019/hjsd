"""reporting.funds：资金日报。
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any
from app.core.security import CurrentUser
from app.domain.foundation import Pool
from sqlalchemy import (
    case,
    func,
    select,
)
from sqlalchemy.orm import Session
from app.domain.enums import (
    CashflowStatus,
    Direction,
    Nature,
)
from app.domain.trade import (
    Cashflow,
    Deposit,
)

from ._shared import (
    ZERO,
    _money,
    _sum_report_field,
    _visible_pool_ids,
)

def daily_funds_report(
    session: Session, *, on: date | None = None, user: CurrentUser | None = None
) -> dict[str, Any]:
    """资金日报：各池期初、经营收支、内部划转、押金与可用余额。"""
    from app.orders.service import pool_balances

    target = on or date.today()
    pool_stmt = select(Pool)
    visible = _visible_pool_ids(user)
    if visible is not None:
        pool_stmt = pool_stmt.where(Pool.id.in_(visible))
    pools = session.scalars(pool_stmt).all()
    ids = [pool.id for pool in pools]

    # 逐池标量查询改为一次分组聚合：期初按池累计有符号和，当日按 (方向, 性质) 分箱。
    opening_by_pool: dict[int, Decimal] = {}
    day_cells: dict[int, dict[tuple[str, str], Decimal]] = {}
    deposit_paid_by_pool: dict[int, Decimal] = {}
    if ids:
        for pool_id, amount in session.execute(
            select(
                Cashflow.pool_id,
                func.coalesce(
                    func.sum(
                        case(
                            (Cashflow.direction == Direction.IN.value, Cashflow.amount),
                            else_=-Cashflow.amount,
                        )
                    ),
                    0,
                ),
            )
            .where(
                Cashflow.pool_id.in_(ids),
                Cashflow.occurred_on < target,
                Cashflow.status == CashflowStatus.APPROVED.value,
            )
            .group_by(Cashflow.pool_id)
        ):
            opening_by_pool[pool_id] = _money(amount)
        for pool_id, direction, nature, amount in session.execute(
            select(
                Cashflow.pool_id,
                Cashflow.direction,
                Cashflow.nature,
                func.coalesce(func.sum(Cashflow.amount), 0),
            )
            .where(
                Cashflow.pool_id.in_(ids),
                Cashflow.occurred_on == target,
                Cashflow.status == CashflowStatus.APPROVED.value,
            )
            .group_by(Cashflow.pool_id, Cashflow.direction, Cashflow.nature)
        ):
            day_cells.setdefault(pool_id, {})[(direction, nature)] = _money(amount)
        for pool_id, amount in session.execute(
            select(Deposit.pool_id, func.coalesce(func.sum(Deposit.paid_amount), 0))
            .where(Deposit.pool_id.in_(ids), Deposit.paid_on == target)
            .group_by(Deposit.pool_id)
        ):
            deposit_paid_by_pool[pool_id] = _money(amount)

    # 池可见性已由上面的 pool_stmt 收敛，这里不再重复做 can_see_pool 校验，
    # 与改动前 pool_balance(session, pool.id) 不传 user 的行为一致。
    balances = pool_balances(session, ids) if ids else {}

    items = []
    for pool in pools:
        bucket = day_cells.get(pool.id, {})
        balance = balances[pool.id]
        items.append(
            {
                "pool_code": pool.code,
                "pool_name": pool.name,
                "opening": opening_by_pool.get(pool.id, ZERO),
                "income": bucket.get(
                    (Direction.IN.value, Nature.BUSINESS_IN.value), ZERO
                ),
                "expense": bucket.get(
                    (Direction.OUT.value, Nature.BUSINESS_OUT.value), ZERO
                ),
                "transfer_in": bucket.get(
                    (Direction.IN.value, Nature.INTERNAL.value), ZERO
                ),
                "transfer_out": bucket.get(
                    (Direction.OUT.value, Nature.INTERNAL.value), ZERO
                ),
                "deposit_paid": deposit_paid_by_pool.get(pool.id, ZERO),
                "deposit_held": balance["deposit_held"],
                "cash_balance": balance["cash_balance"],
                "available": balance["available"],
            }
        )
    return {
        "date": target.isoformat(),
        "items": items,
        "total": {
            "opening": _sum_report_field(items, "opening"),
            "income": _sum_report_field(items, "income"),
            "expense": _sum_report_field(items, "expense"),
            "transfer_in": _sum_report_field(items, "transfer_in"),
            "transfer_out": _sum_report_field(items, "transfer_out"),
            "deposit_paid": _sum_report_field(items, "deposit_paid"),
            "deposit_held": _sum_report_field(items, "deposit_held"),
            "cash_balance": _sum_report_field(items, "cash_balance"),
            "available": _sum_report_field(items, "available"),
        },
    }


# --------------------------------------------------------------------- 订单利润
