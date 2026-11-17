"""installments 路由聚合入口（HS-01-06 分期合约）。

合约、期次、收付款、处置交付四组端点分别定义在 routers/ 下的
contracts_router / schedules_router / payments_router /
dispositions_router；此处只做聚合挂载，与 finance/router.py 的模式一致。
API URL 与挂载点不变。

注意 include 顺序：与原 router.py 中的路由注册顺序一致，避免路径参数
路由（/installments/{installment_id}/...）与静态路由的匹配次序变化。
"""
from fastapi import APIRouter

from .routers.contracts_router import router as contracts_router
from .routers.dispositions_router import router as dispositions_router
from .routers.payments_router import router as payments_router
from .routers.schedules_router import router as schedules_router

router = APIRouter()
router.include_router(contracts_router)
router.include_router(schedules_router)
router.include_router(payments_router)
router.include_router(dispositions_router)

__all__ = ["router"]
