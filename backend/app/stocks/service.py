"""账号域服务门面。

账号资料、库存查询与共享可见范围分别位于独立模块；本文件只提供统一领域入口。
"""
from ._common import account_is_visible
from .lifecycle import (
    apply_account_event_effect,
    apply_cancellation_effect,
    apply_installment_cancellation,
    mark_delivered,
    retire_for_plain_cancel,
)
from .inventory import (
    count_accounts,
    inventory,
    inventory_age_days,
    inventory_stats,
    list_accounts,
    total_inventory_cost,
)
from .profile import create_account, delete_account, get_account, update_account_profile

__all__ = [
    "account_is_visible",
    "apply_account_event_effect",
    "apply_cancellation_effect",
    "apply_installment_cancellation",
    "count_accounts",
    "create_account",
    "delete_account",
    "get_account",
    "inventory",
    "inventory_age_days",
    "inventory_stats",
    "list_accounts",
    "mark_delivered",
    "retire_for_plain_cancel",
    "total_inventory_cost",
    "update_account_profile",
]
