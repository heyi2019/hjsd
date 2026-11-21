"""orders 路由聚合入口（ORD-01/02、FIN-01）。

订单、事件、执行详情三组端点分别定义在 routers/ 下的
orders_router / order_events_router / order_execution_router；此处只做聚合挂载。

注意 include 顺序：orders_router 内 list→ledger-summary→create→get…
保持原注册顺序，确保 /orders/ledger-summary 不被 /orders/{order_id} 吞掉。
"""
from fastapi import APIRouter

from .routers.order_events_router import router as order_events_router
from .routers.order_execution_router import router as order_execution_router
from .routers.orders_router import router as orders_router

router = APIRouter()
router.include_router(order_execution_router)
router.include_router(orders_router)
router.include_router(order_events_router)

__all__ = ["router"]
