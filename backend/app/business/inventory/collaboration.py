"""库存与订单间的协作注册点。

订单域提供详情加载、列表组装与订单删除能力；库存模块通过这些注册点
复用能力，并让关联操作保持在同一事务内。应用路由加载时完成注册。
"""
from __future__ import annotations

from typing import Any

# 订单执行明细加载器：签名 (db, order_id, user)，返回执行明细读模型或抛错
_order_execution_loader: Any = None
_order_execution_batch_loader: Any = None

# 订单列表摘要组装器：签名 (db, orders) -> list[dict]
_order_list_payload_builder: Any = None

# 绑定订单删除器：签名 (session, order_id, *, actor, reason, user, delete_inventory_after)
_linked_order_deleter: Any = None


def register_order_execution_loader(loader: Any) -> None:
    """注册订单执行明细加载器（由 orders 域调用）。"""
    global _order_execution_loader
    _order_execution_loader = loader


def register_order_execution_batch_loader(loader: Any) -> None:
    global _order_execution_batch_loader
    _order_execution_batch_loader = loader


def load_order_execution_batch(db: Any, order_ids: list[int], user: Any) -> list[Any]:
    if _order_execution_batch_loader is None:
        raise RuntimeError("订单执行明细批量加载器未注册")
    return _order_execution_batch_loader(db, order_ids, user)


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
            "（注册点 app.business.inventory.collaboration）"
        )
    return _order_execution_loader(*args, **kwargs)


def build_order_list_payload(*args: Any, **kwargs: Any) -> Any:
    """组装订单列表摘要（转发给 orders 注册的组装器）；未注册 fail-fast。"""
    if _order_list_payload_builder is None:
        raise RuntimeError(
            "订单列表摘要组装器未注册：orders/router_outputs/list_payload 未被加载"
            "（注册点 app.business.inventory.collaboration）"
        )
    return _order_list_payload_builder(*args, **kwargs)


def delete_linked_order(*args: Any, **kwargs: Any) -> Any:
    """删除绑定订单（转发给 orders 注册的删除器）。

    未注册即抛错：库存删除联动订单是账务级删除，静默跳过会留下孤立订单，必须 fail-fast。
    """
    if _linked_order_deleter is None:
        raise RuntimeError(
            "绑定订单删除器未注册：orders/deletion 未被加载"
            "（注册点 app.business.inventory.collaboration）"
        )
    return _linked_order_deleter(*args, **kwargs)


__all__ = [
    "build_order_list_payload",
    "delete_linked_order",
    "load_order_execution",
    "load_order_execution_batch",
    "register_linked_order_deleter",
    "register_order_execution_loader",
    "register_order_execution_batch_loader",
    "register_order_list_payload_builder",
]
