"""policy.service：经营规则定义 / 版本 / 审批 / 生效期解析 / 利润分配统一入口。

本模块是兼容层（facade），只做符号再导出，不含业务逻辑：
- 共用工具 → `app.policy._shared`
- 规则定义 → `app.policy.definitions`
- 版本与生效期 → `app.policy.versions`
- 利润分配 → `app.policy.allocations`

红线（BAS-06-02 / BAS-06-04）：
1. **已被引用的版本不可修改/删除** —— 只能新建版本；
2. **同范围的新版本不得与已有版本有效期重叠**；
3. **已发生的业务不因规则改版而变化** —— 靠 `resolve_version` 返回
   「当时生效的版本」+ 业务对象上的 `policy_snapshot` 固化实现；
4. 发布只影响 `effective_from` 之后**新建**的业务，不重算历史。

有效期模型：`[effective_from, effective_to)` 左闭右开，NULL 表示至今。
"""
from __future__ import annotations

from ._shared import (
    _def_out,
    _normalize_policy_config,
    _required_text,
    _scoped_order,
    _ver_out,
)
from .allocations import (
    _normalize_allocation_item,
    _set_action_allocations,
    _set_person_allocations,
    list_allocations,
    set_allocations,
)
from .definitions import create_definition, get_definition, list_definitions
from .versions import (
    _overlaps,
    create_version,
    expire_lapsed_versions,
    list_versions,
    make_snapshot,
    resolve_version,
    snapshot_for,
    supersede_draft_version,
    update_version_draft,
)

__all__ = [
    "_def_out",
    "_normalize_allocation_item",
    "_normalize_policy_config",
    "_overlaps",
    "_required_text",
    "_scoped_order",
    "_set_action_allocations",
    "_set_person_allocations",
    "_ver_out",
    "create_definition",
    "create_version",
    "expire_lapsed_versions",
    "get_definition",
    "list_allocations",
    "list_definitions",
    "list_versions",
    "make_snapshot",
    "resolve_version",
    "set_allocations",
    "snapshot_for",
    "supersede_draft_version",
    "update_version_draft",
]
