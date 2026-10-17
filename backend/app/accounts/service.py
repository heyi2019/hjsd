"""账号域服务门面。

账号资料、库存查询与共享可见范围分别位于独立模块；本文件只提供统一领域入口。
"""
from ._common import account_is_visible
from .inventory import inventory, list_accounts, total_inventory_cost
from .profile import create_account, get_account, update_account_profile

__all__ = [
    "account_is_visible",
    "create_account",
    "get_account",
    "inventory",
    "list_accounts",
    "total_inventory_cost",
    "update_account_profile",
]
