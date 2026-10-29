"""foundation 服务门面。

资金池、业务类型/资金路由、编号序列分别位于独立模块；保留本门面作为领域内统一导入入口。
"""
from .order_types import (
    create_order_type,
    get_order_type_by_code,
    list_order_types,
    list_routes,
    require_default_pool,
    require_order_type_by_code,
    resolve_default_pool,
    route_impact_preview,
    set_order_type_active,
    set_route,
    update_order_type,
)
from .game_types import (
    create_game_type,
    delete_game_type,
    list_game_types,
    set_game_type_active,
    set_game_type_default,
    update_game_type,
)
from .pools import (
    _has_cashflow,
    assert_pool_usable,
    create_pool,
    delete_pool,
    get_pool_by_code,
    list_pools,
    require_pool_by_code,
    set_pool_status,
    update_pool,
)
from .sequences import ensure_order_sequence, list_sequences, next_order_no, preview_order_no

__all__ = [
    "assert_pool_usable",
    "_has_cashflow",
    "create_order_type",
    "create_pool",
    "delete_pool",
    "ensure_order_sequence",
    "get_order_type_by_code",
    "get_pool_by_code",
    "list_order_types",
    "list_pools",
    "list_routes",
    "list_sequences",
    "next_order_no",
    "preview_order_no",
    "require_default_pool",
    "require_order_type_by_code",
    "require_pool_by_code",
    "resolve_default_pool",
    "route_impact_preview",
    "set_order_type_active",
    "set_pool_status",
    "set_route",
    "update_order_type",
    "update_pool",
    "create_game_type",
    "delete_game_type",
    "list_game_types",
    "set_game_type_active",
    "set_game_type_default",
    "update_game_type",
]
