"""押金查询：列表与在押合计。"""
from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.trade import Deposit
from app.finance.pool_scope import visible_pool_ids


def list_deposits(
    session: Session,
    *,
    pool_id: int | None = None,
    pool_ids: Iterable[int] | None = None,
    user: CurrentUser | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> list[Deposit] | tuple[list[Deposit], int]:
    visible = visible_pool_ids(user, pool_id=pool_id, pool_ids=pool_ids)
    if visible == []:
        return ([], 0) if limit is not None else []
    stmt = select(Deposit)
    if visible is not None:
        stmt = stmt.where(Deposit.pool_id.in_(visible))
    total = (session.scalar(select(func.count()).select_from(stmt.subquery())) or 0) if limit is not None else None
    items = list(session.scalars(stmt.order_by(Deposit.id).limit(limit).offset(offset)).all())
    return (items, total) if limit is not None else items


def deposit_held_total(
    session: Session,
    pool_id: int | None = None,
    *,
    user: CurrentUser | None = None,
) -> Decimal:
    """在押押金合计 = Σ(实缴 − 已退 − 已损失)，可按池过滤。

    与 `PoolBalanceOut.deposit_held` 信息列同源；占用已进资金账户 OUT，
    此值仅作台账展示，不参与可用余额二次扣减。
    """
    stmt = select(
        func.coalesce(
            func.sum(Deposit.paid_amount - Deposit.returned_amount - Deposit.lost_amount),
            0,
        )
    )
    visible = visible_pool_ids(user, pool_id=pool_id)
    if visible == []:
        return Decimal("0.00")
    if visible is not None:
        stmt = stmt.where(Deposit.pool_id.in_(visible))
    return to_money(session.scalar(stmt) or 0)
