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
    list_rebates,
)
from .cashflows import (
    cancel_deposit,
    cashflow_totals,
    create_business_event_cashflow,
    create_cashflow,
    create_deposit,
    list_cashflows,
    list_deposits,
    lose_deposit,
    return_deposit,
    reverse_cashflow,
    studio_summary,
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
    "cancel_deposit",
    "cashflow_totals",
    "studio_summary",
    "create_cashflow",
    "create_business_event_cashflow",
    "create_deposit",
    # 以下两项为路由层门面再导出：app/finance/router.py 通过 service.<name> 访问，
    # 不可删除（否则 500）；列在 __all__ 中既保留门面，又让静态检查认账。
    "create_rebate",
    "deposit_held_total",
    "list_cashflows",
    "create_reconciliation",
    "list_reconciliations",
    "resolve_reconciliation",
    "list_deposits",
    "list_rebates",
    "get_rebate",
    "create_transfer",
    "repair_transfer",
    "return_deposit",
    "lose_deposit",
    "reverse_cashflow",
]
