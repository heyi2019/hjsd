"""finance 领域统一服务门面。"""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.domain.trade import Deposit

from .rebates import (
    create_rebate,
    get_rebate,
    list_overdue_rebates,
    list_rebate_settlements,
    list_rebates,
    reverse_rebate_settlement,
    settle_rebate,
    settled_net_total,
    sync_overdue_rebate_notifications,
    void_rebate,
)
from .cashflows import (
    approve_cashflow,
    cancel_deposit,
    create_cashflow,
    create_deposit,
    create_period_lock,
    list_cashflows,
    list_deposits,
    list_period_locks,
    lose_deposit,
    reject_cashflow,
    return_deposit,
    reverse_cashflow,
)
from .reconciliation import (
    create_reconciliation,
    list_reconciliations,
    resolve_reconciliation,
)
from .transfers import create_transfer, repair_transfer


def deposit_held_total(session: Session, pool_id: int | None = None) -> Decimal:
    stmt = select(
        func.coalesce(
            func.sum(Deposit.paid_amount - Deposit.returned_amount - Deposit.lost_amount),
            0,
        )
    )
    if pool_id:
        stmt = stmt.where(Deposit.pool_id == pool_id)
    return to_money(session.scalar(stmt) or 0)




__all__ = [
    "approve_cashflow",
    "cancel_deposit",
    "create_cashflow",
    "create_deposit",
    "create_rebate",
    "deposit_held_total",
    "list_cashflows",
    "create_reconciliation",
    "list_reconciliations",
    "resolve_reconciliation",
    "list_deposits",
    "list_rebates",
    "list_overdue_rebates",
    "sync_overdue_rebate_notifications",
    "get_rebate",
    "create_transfer",
    "repair_transfer",
    "return_deposit",
    "lose_deposit",
    "reject_cashflow",
    "reverse_cashflow",
    "settle_rebate",
    "list_rebate_settlements",
    "reverse_rebate_settlement",
    "settled_net_total",
    "void_rebate",
]
