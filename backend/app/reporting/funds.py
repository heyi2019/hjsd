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
)
from app.domain.trade import (
    Cashflow,
    Deposit,
)
from app.orders.amounts import business_cashflow_filter

from ._shared import (
    ZERO,
    _money,
    _sum_report_field,
    _visible_pool_ids,
)

def daily_funds_report(
    session: Session, *, on: date | None = None, user: CurrentUser | None = None
) -> dict[str, Any]:
    """资金日报：各池期初、收入/支出两方向、押金与可用余额。

    2026-11-12 口径：资金中心每个资金账户所有流动只按收入(IN)/支出(OUT)两方向
    呈现——当日该池全部 IN 流水进 income、全部 OUT 流水进 expense。外部注入、
    押金释放、内部划入并入收入；押金占用、内部划出并入支出。售出/返点是收入
    子类型、回收/提号是支出子类型，内部划转对划出账户是支出、对划入账户是收入
    ——这些业务名词都是两方向下的「其中项」，不单列方向。
    `deposit_paid` 是「其中：押金缴纳」信息列，不参与收入/支出发生额合计，
    以免与 expense 中的押金占用重复计算。
    """
    from app.orders.pools import pool_balances

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
                business_cashflow_filter(),
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
                business_cashflow_filter(),
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
                # 资金中心只有收入/支出两方向：当日该池全部 IN / 全部 OUT。
                # 外部注入、押金释放、内部划入并入 income；押金占用、内部划出
                # 并入 expense。子类型只在明细层作「其中项」，这里不单列方向。
                "income": sum(
                    (amount for (d, _n), amount in bucket.items() if d == Direction.IN.value),
                    ZERO,
                ),
                "expense": sum(
                    (amount for (d, _n), amount in bucket.items() if d == Direction.OUT.value),
                    ZERO,
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
            "deposit_paid": _sum_report_field(items, "deposit_paid"),
            "deposit_held": _sum_report_field(items, "deposit_held"),
            "cash_balance": _sum_report_field(items, "cash_balance"),
            "available": _sum_report_field(items, "available"),
        },
    }


# --------------------------------------------------------------------- 订单利润
