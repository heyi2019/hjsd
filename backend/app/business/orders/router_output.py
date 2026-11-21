"""订单与事件接口的输出装配入口，并注册库存台账使用的订单列表组装器。"""
from __future__ import annotations

from app.core.actor import actor_name as _actor
from app.business.output_labels import _selected_operator_label
from app.business.orders.router_outputs._shared import (
    _event_output,
    _operator_names,
    _order_output,
    cancellable_by_event,
)
from app.business.orders.router_outputs.detail import _order_detail_output
from app.business.orders.router_outputs.list_payload import _order_list_payload

__all__ = [
    "_actor",
    "cancellable_by_event",
    "_order_output",
    "_operator_names",
    "_event_output",
    "_selected_operator_label",
    "_order_detail_output",
    "_order_list_payload",
]

# 库存台账通过协作注册点复用订单列表输出。
from app.business.inventory.collaboration import register_order_list_payload_builder  # noqa: E402

register_order_list_payload_builder(_order_list_payload)
