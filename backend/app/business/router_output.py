"""orders.router_output：订单/事件接口输出装配的整合入口（列表、详情、操作人标签）。

实现已拆至 `orders/router_outputs/`（detail / list_payload / _shared）；本文件保留
整合出口与 stocks 列表输出注册点，调用方无需改动。
"""
from __future__ import annotations

from app.core.actor import actor_name as _actor
from app.business.output_labels import _selected_operator_label
from app.business.router_outputs._shared import (
    _event_output,
    _operator_names,
    _order_output,
    cancellable_by_event,
)
from app.business.router_outputs.detail import _order_detail_output
from app.business.router_outputs.list_payload import _order_list_payload

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

# 跨域注册（P0-A 第三批）：stocks 台账页的订单列输出经注册点取用，
# stocks 不反向 import 本模块（合法方向只有 orders -> stocks）。
from app.business.stocks.collaboration import register_order_list_payload_builder  # noqa: E402

register_order_list_payload_builder(_order_list_payload)
