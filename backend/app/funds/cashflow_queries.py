"""finance 现金流查询层：资金流水的统一筛选、明细列表与合计。

拆分原因：原 cashflows.py 同时承载写路径与查询层，查询条件与写路径无共享状态。
实现已拆至 `finance/cashflow_reads/`（_shared / list / totals / studio）；
`_shared._apply_cashflow_filters` 仍是明细与合计共用的同一份条件，口径不漂移。
本文件保留整合出口，调用方无需改动。
"""
from __future__ import annotations
from app.funds.cashflow_reads._shared import (  # noqa: F401
    _apply_cashflow_filters, _attach_extra_values, _direction_sums, _flow_row, _like_pattern,
)
from app.funds.cashflow_reads.list import list_cashflows
from app.funds.cashflow_reads.totals import cashflow_totals
from app.funds.cashflow_reads.studio import _studio_scope, studio_summary  # noqa: F401
__all__ = [
    "cashflow_totals", "list_cashflows", "studio_summary",
    "_apply_cashflow_filters", "_attach_extra_values", "_direction_sums",
    "_flow_row", "_like_pattern", "_studio_scope",
]
