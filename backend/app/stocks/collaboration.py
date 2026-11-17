"""stocks 域的跨域协作注册点（composition root 回调注册表）。

背景（2026-11-18 P0-A 第三批）：stocks 禁止反向依赖 orders
（backend/.importlinter 契约，合法方向只有 orders -> stocks）。但三处业务行为
天然需要订单域的能力——

1. 库存台账导出：stocks/export 组装 CSV 时需要订单「执行明细 + 资金明细」读模型
   （orders.order_detail.view.execution.load_order_execution_detail）；
2. 库存台账页：stocks/router 组装订单列输出时需要订单摘要读模型
   （orders.router_output._order_list_payload）；
3. 库存删除联动：stocks/deletion 删除库存前必须先删除绑定订单
   （orders.deletion.delete_order），同事务完成。

解决方案与 app/orders/collaboration.py 同构：stocks 在本模块定义注册点
（stocks 不 import orders）；orders 在**自己模块底部**调用 register_* 完成注册。

加载链保证注册生效：
- 生产：api_v1 import orders_router -> orders/router.py 顶部 import deletion /
  router_output / order_detail.view.execution，三个 provider 模块随路由链加载；
- 测试：tests/backend/conftest.py 模块级 import app.api_v1.create_app，
  收集阶段即完成注册。
"""
from __future__ import annotations

from typing import Any

# 订单执行明细加载器：签名 (db, order_id, user)，返回执行明细读模型或抛错
_order_execution_loader: Any = None

# 订单列表摘要组装器：签名 (db, orders) -> list[dict]
_order_list_payload_builder: Any = None

# 绑定订单删除器：签名 (session, order_id, *, actor, reason, user, delete_inventory_after)
_linked_order_deleter: Any = None


def register_order_execution_loader(loader: Any) -> None:
    """注册订单执行明细加载器（由 orders 域调用）。"""
    global _order_execution_loader
    _order_execution_loader = loader


def register_order_list_payload_builder(builder: Any) -> None:
    """注册订单列表摘要组装器（由 orders 域调用）。"""
    global _order_list_payload_builder
    _order_list_payload_builder = builder


def register_linked_order_deleter(deleter: Any) -> None:
    """注册绑定订单删除器（由 orders 域调用）。"""
    global _linked_order_deleter
    _linked_order_deleter = deleter


def load_order_execution(*args: Any, **kwargs: Any) -> Any:
    """加载订单执行明细（转发给 orders 注册的加载器）。

    未注册即抛错：导出明细缺列会造成静默数据缺失，必须 fail-fast。
    """
    if _order_execution_loader is None:
        raise RuntimeError(
            "订单执行明细加载器未注册：orders/order_detail/view/execution 未被加载"
            "（注册点 app.stocks.collaboration）"
        )
    return _order_execution_loader(*args, **kwargs)


def build_order_list_payload(*args: Any, **kwargs: Any) -> Any:
    """组装订单列表摘要（转发给 orders 注册的组装器）；未注册 fail-fast。"""
    if _order_list_payload_builder is None:
        raise RuntimeError(
            "订单列表摘要组装器未注册：orders/router_output 未被加载"
            "（注册点 app.stocks.collaboration）"
        )
    return _order_list_payload_builder(*args, **kwargs)


def delete_linked_order(*args: Any, **kwargs: Any) -> Any:
    """删除绑定订单（转发给 orders 注册的删除器）。

    未注册即抛错：库存删除联动订单是账务级删除，静默跳过会留下孤立订单，必须 fail-fast。
    """
    if _linked_order_deleter is None:
        raise RuntimeError(
            "绑定订单删除器未注册：orders/deletion 未被加载"
            "（注册点 app.stocks.collaboration）"
        )
    return _linked_order_deleter(*args, **kwargs)


__all__ = [
    "build_order_list_payload",
    "delete_linked_order",
    "load_order_execution",
    "register_linked_order_deleter",
    "register_order_execution_loader",
    "register_order_list_payload_builder",
]
