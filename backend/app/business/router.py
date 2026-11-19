"""orders 路由聚合入口（ORD-01/02、FIN-01）。

订单、事件、执行详情三组端点分别定义在 routers/ 下的
orders_router / order_events_router / order_execution_router；此处只做聚合挂载与旧符号再导出（供既有测试与
调用方），与 customer_center/router.py、finance/router.py 的模式一致。API URL 不变。

注意 include 顺序：orders_router 内 list→ledger-summary→create→get…
保持原注册顺序，确保 /orders/ledger-summary 不被 /orders/{order_id} 吞掉。
"""
from fastapi import APIRouter

from .routers.order_events_router import router as order_events_router
from .routers.order_execution_router import router as order_execution_router
from .routers.orders_router import router as orders_router

# 旧符号再导出：test_orders_router_guard 等仍从 app.business.router 取用。
from .routers.orders_router import create_order
from .router_output import _order_list_payload, _order_output

router = APIRouter()
router.include_router(order_execution_router)
router.include_router(orders_router)
router.include_router(order_events_router)

__all__ = [
    "router",
    "create_order",
    "_order_output",
    "_order_list_payload",
]
