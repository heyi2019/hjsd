"""押金查询：列表与在押合计。"""
from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.trade import Deposit

from ._shared import _can_see_pool, _is_scope_all, _visible_pool_ids


def list_deposits(
    session: Session,
    *,
    pool_id: int | None = None,
    pool_ids: Iterable[int] | None = None,
    user: CurrentUser | None = None,
) -> list[Deposit]:
    stmt = select(Deposit)
    if pool_id is not None:
        if not _can_see_pool(user, pool_id):
            return []
        stmt = stmt.where(Deposit.pool_id == pool_id)
    elif pool_ids is not None:
        stmt = stmt.where(Deposit.pool_id.in_(_visible_pool_ids(user, pool_ids)))
    elif not _is_scope_all(user):
        stmt = stmt.where(Deposit.pool_id.in_(sorted(user.pool_ids)))  # type: ignore[union-attr]
    return list(session.scalars(stmt.order_by(Deposit.id)).all())


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
    if pool_id:
        stmt = stmt.where(Deposit.pool_id == pool_id)
    elif not _is_scope_all(user):
        stmt = stmt.where(Deposit.pool_id.in_(sorted(user.pool_ids)))  # type: ignore[union-attr]
    return to_money(session.scalar(stmt) or 0)
