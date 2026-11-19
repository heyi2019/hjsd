"""field_definitions 路由共享依赖（权限门控）。"""
from __future__ import annotations

from app.core.security import (
    PERM_FINANCE_READ,
    PERM_ORDER_TYPE_MANAGE,
    PERM_POOL_MANAGE,
)
from app.settings.auth.session import require_permissions

read_access = require_permissions(PERM_FINANCE_READ, PERM_POOL_MANAGE, require_all=False)
manage_pools = require_permissions(PERM_POOL_MANAGE)
manage_order_types = require_permissions(PERM_ORDER_TYPE_MANAGE)
manage_game_types = require_permissions(PERM_ORDER_TYPE_MANAGE)
