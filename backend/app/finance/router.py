"""财务路由聚合入口，并保留旧模块的端点函数导出。"""
from fastapi import APIRouter

from .cashflows_router import (
    router as cashflows_router,
    studio_summary,
    list_cashflows,
    export_cashflows_csv,
    create_cashflow,
    create_order_cashflow,
    reverse_cashflow,
)
from .reconciliation_router import (
    router as reconciliation_router,
    list_reconciliations,
    create_reconciliation,
    resolve_reconciliation,
    create_transfer,
    repair_transfer,
)
from .deposits_router import (
    router as deposits_router,
    list_deposits,
    create_deposit,
    return_deposit,
    cancel_deposit,
    lose_deposit,
)
from .rebates_router import (
    router as rebates_router,
    list_rebates,
    export_rebates_csv,
    get_rebate,
    create_rebate,
    update_rebate,
    return_rebate,
)

router = APIRouter()
router.include_router(cashflows_router)
router.include_router(reconciliation_router)
router.include_router(deposits_router)
router.include_router(rebates_router)

__all__ = [
    "router",
    "studio_summary",
    "list_cashflows",
    "export_cashflows_csv",
    "create_cashflow",
    "create_order_cashflow",
    "reverse_cashflow",
    "list_reconciliations",
    "create_reconciliation",
    "resolve_reconciliation",
    "create_transfer",
    "repair_transfer",
    "list_deposits",
    "create_deposit",
    "return_deposit",
    "cancel_deposit",
    "lose_deposit",
    "list_rebates",
    "export_rebates_csv",
    "get_rebate",
    "create_rebate",
    "update_rebate",
    "return_rebate",
]
