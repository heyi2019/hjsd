"""客户中心路由聚合入口。

客户档案（/customers）、需求池（/leads）、合作方（/counterparties）三组端点
分别定义在 customers_router / leads_router / counterparties_router；此处只做
聚合挂载，与 finance/router.py 的模式一致。API URL 不变。
"""
from fastapi import APIRouter

from .counterparties_router import router as counterparties_router
from .customers_router import router as customers_router
from .leads_router import router as leads_router

router = APIRouter()
router.include_router(customers_router)
router.include_router(leads_router)
router.include_router(counterparties_router)

__all__ = ["router"]
