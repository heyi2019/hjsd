"""财务路由聚合入口。"""
from fastapi import APIRouter

from .cashflows_router import router as cashflows_router
from .deposits_router import router as deposits_router
from .rebates_router import router as rebates_router
from .reconciliation_router import router as reconciliation_router

router = APIRouter()
router.include_router(cashflows_router)
router.include_router(reconciliation_router)
router.include_router(deposits_router)
router.include_router(rebates_router)

__all__ = ["router"]
