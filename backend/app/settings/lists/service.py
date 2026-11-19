"""lists.service：列表列配置的读取与保存 + 自定义列定义的整合入口。

口径：
- 列清单与中文名以注册表为准，库只存 is_visible / sort_order / fixed；
- 缺行的列（新增列）默认可见，按注册表位置插入，不需要数据迁移；
- 锁定列（身份列/操作列）不允许隐藏，后端二次校验，不能只靠前端置灰；
- fixed 只存「覆盖值」，None 表示不固定；
- 保存整表覆盖该 scope，并写审计（前后值都记，便于追溯谁把哪列关了）。

自定义列（ListCustomColumn）：
- 定义（列名 + 数据来源字段键 + 选项中文快照）单独存表，显示状态仍复用 ListColumnConfig；
- 列键统一 `extra:{field_key}`，与注册表内置列命名空间隔离；
- 恢复默认只清显示配置行，**不删自定义列定义**（新增的列是配置资产，删除需显式操作）；
- 值从行数据 `form_extra` / `extra_values` 按 source_key 取，见前端 listColumns.ts。

实现已拆至 `lists/services/`（configs / labels / custom_columns / _shared）；本文件
保留整合出口，调用方无需改动。
"""
from __future__ import annotations

from app.settings.lists.services._shared import CUSTOM_KEY_PREFIX
from app.settings.lists.services.configs import get_config, list_configs, reset_config, save_config
from app.settings.lists.services.custom_columns import (
    add_custom_column,
    list_custom_field_options,
    remove_custom_column,
)
from app.settings.lists.services.labels import get_value_labels, option_labels_by_code

__all__ = [
    "CUSTOM_KEY_PREFIX",
    "add_custom_column",
    "get_config",
    "get_value_labels",
    "list_configs",
    "list_custom_field_options",
    "option_labels_by_code",
    "remove_custom_column",
    "reset_config",
    "save_config",
]
