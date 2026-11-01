"""orders 订单服务门面：订单建档、查询、更新与资金池汇总。

本模块是兼容层（facade），只做符号再导出，不含业务逻辑：
- 共用工具 → `app.orders._shared`
- 建档与参与方 → `app.orders.create`
- 订单关联 → `app.orders.links`
- 列表查询 → `app.orders.queries`
- 更新与取消 → `app.orders.mutations`
- 资金池余额 → `app.orders.pools`
- 事件登记 → `app.orders.events`（继续对外提供原入口）

不可突破的口径：
- 订单汇总、账号成本、分期已收一律**由事件派生**，禁止直接写（ORD-02-02）；
- 一个事件最多派生一条有效现金流；`DELIVER` 无金额、无现金流；
- 资金池优先级：事件显式池 > 业务默认路由 > 阻断 `POOL_ROUTE_MISSING`（ORD-02-04）。
"""
from __future__ import annotations

from ._shared import (
    _audit_value,
    _create_inline_inventory_account,
    _normalize_account_snapshot,
    _normalize_commission_value,
    _validate_existing_account_context,
    _validate_participant_roles,
    get_order,
)
from .create import (
    _counterparty_role,
    _customer_role,
    add_customer_role,
    create_order,
)
from .events import _apply_account_effect, _opposite_direction, post_event
from .links import create_order_link, delete_order_link, list_order_links
from .cancellation_model import cancel_order
from .mutations import update_order
from .pools import pool_balance, pool_balances
from .queries import _order_list_stmt, count_orders, list_orders

__all__ = [
    "_apply_account_effect",
    "_audit_value",
    "_counterparty_role",
    "_create_inline_inventory_account",
    "_customer_role",
    "_normalize_account_snapshot",
    "_normalize_commission_value",
    "_opposite_direction",
    "_order_list_stmt",
    "_validate_existing_account_context",
    "_validate_participant_roles",
    "add_customer_role",
    "cancel_order",
    "count_orders",
    "create_order",
    "create_order_link",
    "delete_order_link",
    "get_order",
    "list_order_links",
    "list_orders",
    "pool_balance",
    "pool_balances",
    "post_event",
    "update_order",
]
