"""imports 行级操作：列表、人工映射、跳过、提交落地与对账。

实现已拆至 `imports/row_ops/`（mapping / batch）；
`SOURCE_COLUMN_HINTS`（源列→目标字段裁决）随 preview 落到 batch 模块。
本文件保留整合出口，调用方无需改动。
"""
from __future__ import annotations
from app.imports.row_ops.mapping import assign_mapping, list_rows, skip_row
from app.imports.row_ops.batch import (
    SOURCE_COLUMN_HINTS, commit_batch, preview_mapping, reconciliation_report,
)
__all__ = [
    "list_rows","assign_mapping","skip_row","commit_batch","preview_mapping",
    "SOURCE_COLUMN_HINTS","reconciliation_report",
]
