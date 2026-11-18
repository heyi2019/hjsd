"""policy.versions：规则版本、生效期、审批与生效版本解析（BAS-06-02）。

红线：已被引用的版本不可修改/删除；同范围新版本不得与已有版本有效期重叠；
已发生的业务不因规则改版而变化（`resolve_version` + `policy_snapshot` 固化）。
有效期模型 `[effective_from, effective_to)` 左闭右开，NULL 表示至今。

实现已拆至 `policy/version_ops/`（lifecycle / snapshot）；本文件保留整合出口，
调用方（含测试里的 `policy_versions.*` 属性调用）无需改动。
"""
from __future__ import annotations

from app.policy.version_ops.lifecycle import (
    _overlaps,
    create_version,
    expire_lapsed_versions,
    list_versions,
    supersede_draft_version,
    update_version_draft,
)
from app.policy.version_ops.snapshot import make_snapshot, resolve_version, snapshot_for

__all__ = [
    "_overlaps",
    "list_versions",
    "create_version",
    "update_version_draft",
    "supersede_draft_version",
    "expire_lapsed_versions",
    "resolve_version",
    "make_snapshot",
    "snapshot_for",
]
