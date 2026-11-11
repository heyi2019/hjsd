"""orders.pools：资金池余额卡片（FIN-01 / ORD-02-04）。

优先级：事件显式池 > 业务默认路由 > 阻断 `POOL_ROUTE_MISSING`。
"""

from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal
from typing import Any
from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.foundation import Pool
from sqlalchemy import (
    func,
    select,
)
from sqlalchemy.orm import Session
from app.core.errors import NotFound
from app.domain.trade import Cashflow
from .amounts import business_cashflow_filter
from app.domain.enums import (
    CashflowStatus,
    Direction,
    Nature,
    PoolOwnership,
)

# --------------------------------------------------------------------- 池余额
def pool_balances(
    session: Session, pool_ids: Iterable[int], user: CurrentUser | None = None
) -> dict[int, dict[str, Any]]:
    """批量资金池卡片：一次分组聚合覆盖全部池，避免逐池 7 次查询。

    口径与 ``pool_balance`` 完全一致，只是把「每池 5 次标量聚合 + 1 次押金」
    压成「一次 group by + 一次押金 group by」；池数量不再放大 SQL 条数。
    """
    from app.domain.trade import Deposit

    ids = list(dict.fromkeys(pool_ids))
    if not ids:
        return {}
    pools = {pool.id: pool for pool in session.scalars(select(Pool).where(Pool.id.in_(ids)))}
    for pool_id in ids:
        if pool_id not in pools or (
            user is not None and not user.can_see_pool(pool_id)
        ):
            raise NotFound(f"资金池 {pool_id} 不存在", details={"pool_id": pool_id})

    # (direction, nature, accounting_attribute) -> 已审金额合计。
    # 资金中心两方向口径：押金占用=支出(OUT)、释放/取消=收入(IN)，都进 income/expense；
    # 但押金损失（DEPOSIT + OUT + 非 DEPOSIT_HOLD）是已占用押金的定性转换、非第二次
    # 现金流出，由 business_cashflow_filter 排除，损失体现为押金线「收入−支出」净额。
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
            Cashflow.status == CashflowStatus.APPROVED.value,
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
                    for (d, n, _attribute), amount in bucket.items()
                    if d == direction
                    and (nature is None or n == nature)
                ),
                Decimal("0.00"),
            )

        # 资金中心只有收入/支出两个方向（2026-11-12 用户裁决）：
        #   收入 IN  = 该池全部 IN 流水（经营流入/外部注入/押金释放/内部划入…）
        #   支出 OUT = 该池全部 OUT 流水（经营流出/押金占用/内部划出…）
        # 业务名词都是大类下的子类型（其中项），不单列、不另立方向：
        # 售出/返点/外部注入是收入子类型；回收/提号/押金占用是支出子类型；
        # 内部划转对划出账户记支出、对划入账户记收入（同一 transfer_id 两腿分落两池）。
        income = total(Direction.IN.value)
        expense = total(Direction.OUT.value)
        # 以下两项仅为「其中：内部划转」信息列（属 income/expense 的子集），
        # 供质量巡检快照追溯，不参与方向合计——方向合计只看 income/expense。
        transfer_in = total(Direction.IN.value, Nature.INTERNAL.value)
        transfer_out = total(Direction.OUT.value, Nature.INTERNAL.value)
        cash_balance = income - expense
        deposit_held = deposits.get(pool_id, Decimal("0.00"))
        pool = pools[pool_id]
        result[pool_id] = {
            "pool_id": pool.id,
            "pool_code": pool.code,
            "pool_name": pool.name,
            "income": income,
            "expense": expense,
            "transfer_in": transfer_in,
            "transfer_out": transfer_out,
            "cash_balance": cash_balance,
            "deposit_held": deposit_held,
            "available": cash_balance - deposit_held,
        }
    return result


def pool_balance(
    session: Session, pool_id: int, user: CurrentUser | None = None
) -> dict[str, Any]:
    """资金池卡片：收入/支出两方向、内部划转、押金占用与可用余额（单池）。"""
    return pool_balances(session, [pool_id], user=user)[pool_id]


def pool_balance_summary(
    session: Session, user: CurrentUser | None = None
) -> tuple[list[dict[str, Any]], dict[str, Decimal]]:
    """资金页/数据中心的余额总览：一次返回全部可见池的卡片 + 汇总。

    为什么要这个接口：前端原先按池逐个调 `/pools/{id}/balance`（N+1），再自己
    用浮点把卡片加起来算「总余额 / 可用 / 押金 / 自有权益」。合计口径属于财务事实，
    必须在服务端用 Decimal 算，前端只负责显示。

    汇总口径：
    - `cash_balance` / `available` / `deposit_held`：全部可见池直接累加；
    - `owned_cash_balance`：只累加 `ownership=OWNED` 的池（PRD §1.2 自有权益），
      且按现金头寸计、不扣押金占用——押金仍是自有资金，只是暂时不可用。
    """
    pools = list(
        session.scalars(select(Pool).order_by(Pool.id))
    )
    visible = [
        pool for pool in pools if user is None or user.can_see_pool(pool.id)
    ]
    balances = (
        pool_balances(session, [pool.id for pool in visible], user=user)
        if visible
        else {}
    )
    items = [balances[pool.id] for pool in visible]
    owned_ids = {
        pool.id for pool in visible if pool.ownership == PoolOwnership.OWNED.value
    }
    zero = Decimal("0.00")
    totals = {
        "cash_balance": sum((item["cash_balance"] for item in items), zero),
        "available": sum((item["available"] for item in items), zero),
        "deposit_held": sum((item["deposit_held"] for item in items), zero),
        "owned_cash_balance": sum(
            (balances[pool_id]["cash_balance"] for pool_id in owned_ids), zero
        ),
    }
    return items, totals
