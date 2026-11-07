"""imports.service：标准导入（MIG-01）。

红线（开发任务清单「阻断规则」）：
1. **禁止自动匹配**订单/账号/返点 —— 映射只能由人工指派 `assign_mapping`；
2. **禁止补造单边划转** —— 本模块不写任何 cashflow / order_event；
3. 导入行**不覆盖业务单** —— 导入只落 `import_rows.raw`，不 upsert 业务表；
4. 未映射行提交时保持 `UNMAPPED` 状态并在 `issue_note` 留痕，可见但不阻塞新业务。
"""
from __future__ import annotations

from ._shared import (
    _AMOUNT_KEYS,
    _required_text,
    _validate_optional_id,
    _assert_batch_editable,
    _batch_out,
    _row_out,
    _refresh_counts,
    _raw_amount_sum,
)
from .batches import (
    create_batch,
    list_batches,
    mark_unlinked_transfer,
    rollback_batch,
    create_correction_batch,
    reject_batch,
)
from .rows import (
    list_rows,
    assign_mapping,
    skip_row,
    commit_batch,
    preview_mapping,
    SOURCE_COLUMN_HINTS,
    reconciliation_report,
)

__all__ = [
    "SOURCE_COLUMN_HINTS",
    "assign_mapping",
    "commit_batch",
    "create_batch",
    "create_correction_batch",
    "list_batches",
    "list_rows",
    "mark_unlinked_transfer",
    "preview_mapping",
    "reconciliation_report",
    "reject_batch",
    "rollback_batch",
    "skip_row",
    "_AMOUNT_KEYS",
    "_required_text",
    "_validate_optional_id",
    "_assert_batch_editable",
    "_batch_out",
    "_row_out",
    "_refresh_counts",
    "_raw_amount_sum",
]
