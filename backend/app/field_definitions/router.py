"""field_definitions 路由聚合入口（BAS-02/03 基础主数据）。

游戏类型、资金账户、业务类型、编号四组端点分别定义在 routers/ 下；
此处只做聚合挂载，与 installments/router.py 的模式一致。
include 顺序与原 router.py 的注册顺序一致（game-types → pools → order-types → sequences），
API URL、tags 与挂载点均不变。
"""
from __future__ import annotations

from fastapi import APIRouter

from .routers.game_types_router import router as game_types_router
from .routers.order_types_router import router as order_types_router
from .routers.pools_router import router as pools_router
from .routers.sequences_router import router as sequences_router

router = APIRouter()
router.include_router(game_types_router)
router.include_router(pools_router)
router.include_router(order_types_router)
router.include_router(sequences_router)

__all__ = ["router"]
