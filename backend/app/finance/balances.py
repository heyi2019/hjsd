"""资金池余额投影：所有资金池卡片与可用余额的唯一计算入口。"""
from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import NotFound
from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.enums import Direction, Nature, PoolOwnership
from app.domain.foundation import Pool
from app.domain.trade import Cashflow, Deposit
from app.orders.amounts import business_cashflow_filter


def pool_balances(
    session: Session, pool_ids: Iterable[int], user: CurrentUser | None = None
) -> dict[int, dict[str, Any]]:
    """批量聚合资金池余额，避免逐池查询。"""
    ids = list(dict.fromkeys(pool_ids))
    if not ids:
        return {}
    pools = {
        pool.id: pool
        for pool in session.scalars(select(Pool).where(Pool.id.in_(ids)))
    }
    for pool_id in ids:
        if pool_id not in pools or (user is not None and not user.can_see_pool(pool_id)):
            raise NotFound(f"资金池 {pool_id} 不存在", details={"pool_id": pool_id})

    cells: dict[int, dict[tuple[str, str, str | None], Decimal]] = {}
    for pool_id, direction, nature, attribute, amount in session.execute(
        select(
            Cashflow.pool_id,
            Cashflow.direction,
            Cashflow.nature,
            Cashflow.accounting_attribute,
            func.coalesce(func.sum(Cashflow.amount), 0),
        )
        .where(
            Cashflow.pool_id.in_(ids),
            business_cashflow_filter(),
        )
        .group_by(
            Cashflow.pool_id,
            Cashflow.direction,
            Cashflow.nature,
            Cashflow.accounting_attribute,
        )
    ):
        cells.setdefault(pool_id, {})[(direction, nature, attribute)] = to_money(amount or 0)

    deposits = {
        pool_id: to_money(amount or 0)
        for pool_id, amount in session.execute(
            select(
                Deposit.pool_id,
                func.coalesce(
                    func.sum(
                        Deposit.paid_amount
                        - Deposit.returned_amount
                        - Deposit.lost_amount
                    ),
                    0,
                ),
            )
            .where(Deposit.pool_id.in_(ids))
            .group_by(Deposit.pool_id)
        )
    }

    result: dict[int, dict[str, Any]] = {}
    for pool_id in ids:
        bucket = cells.get(pool_id, {})

        def total(direction: str, nature: str | None = None) -> Decimal:
            return sum(
                (
                    amount
                    for (item_direction, item_nature, _attribute), amount in bucket.items()
                    if item_direction == direction
                    and (nature is None or item_nature == nature)
                ),
                Decimal("0.00"),
            )

        income = total(Direction.IN.value)
        expense = total(Direction.OUT.value)
        pool = pools[pool_id]
        result[pool_id] = {
            "pool_id": pool.id,
            "pool_code": pool.code,
            "pool_name": pool.name,
            "income": income,
            "expense": expense,
            "transfer_in": total(Direction.IN.value, Nature.INTERNAL.value),
            "transfer_out": total(Direction.OUT.value, Nature.INTERNAL.value),
            "cash_balance": income - expense,
            "deposit_held": deposits.get(pool_id, Decimal("0.00")),
            "available": income - expense,
        }
    return result


def pool_balance(
    session: Session, pool_id: int, user: CurrentUser | None = None
) -> dict[str, Any]:
    """返回单个资金池余额投影。"""
    return pool_balances(session, [pool_id], user=user)[pool_id]


def pool_balance_summary(
    session: Session, user: CurrentUser | None = None
) -> tuple[list[dict[str, Any]], dict[str, Decimal]]:
    """返回当前用户可见资金池及服务端汇总。"""
    pools = list(session.scalars(select(Pool).order_by(Pool.id)))
    visible = [pool for pool in pools if user is None or user.can_see_pool(pool.id)]
    balances = pool_balances(session, [pool.id for pool in visible], user=user) if visible else {}
    items = [balances[pool.id] for pool in visible]
    owned_ids = {pool.id for pool in visible if pool.ownership == PoolOwnership.OWNED.value}
    zero = Decimal("0.00")
    totals = {
        "pool_count": len(visible),
        "cash_balance": sum((item["cash_balance"] for item in items), zero),
        "available": sum((item["available"] for item in items), zero),
        "deposit_held": sum((item["deposit_held"] for item in items), zero),
        "owned_cash_balance": sum(
            (balances[pool_id]["cash_balance"] for pool_id in owned_ids), zero
        ),
    }
    return items, totals


__all__ = ["pool_balances", "pool_balance", "pool_balance_summary"]
