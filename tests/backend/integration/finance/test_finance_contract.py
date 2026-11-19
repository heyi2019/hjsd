"""DEPOSIT-01 finance 顶层契约：返点校验与共享 helper。

按 class 拆分后的保留文件；其余 class 分别在 deposits /
rebates_guards / reconciliation / api 四个文件。
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4
from sqlalchemy import select

from app.stocks.profile import create_account
from app.domain.foundation import Pool
from app.orders.create import create_order
from app.orders.events import post_event

TODAY = date(2026, 10, 4)


def _pool(seeded_db, code: str) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == code))
    assert pool is not None
    return pool


def _active_order(seeded_db) -> int:
    account = create_account(
        seeded_db,
        game_account=f"finance-active-{uuid4().hex[:10]}",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    order = create_order(
        seeded_db,
        order_type="HS",
        trade_date=TODAY,
        actor="pytest",
        account_id=account.id,
    )
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("500"),
        occurred_on=TODAY, actor="pytest",
    )
    return order.id



