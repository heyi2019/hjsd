"""reporting.service：报表 Service 统一入口（兼容层）。

本模块只做符号再导出，不含业务逻辑：
- 共用工具 → `app.reporting._shared`
- 导出 / 维度汇总 → `app.reporting.export`
- R1 库存健康 → `app.reporting.r1_inventory`
- R2 月度损益 → `app.reporting.r2_monthly_pnl`
- R3 提成对账 → `app.reporting.r3_commission`
- R5 业务损益 → `app.reporting.r5_business_pnl`
- 资金日报 → `app.reporting.funds`
- 订单利润明细 → `app.reporting.profit`

口径红线：
- 账号 COST 属直接成本，**不进运营费用**（R2 验收「作图费不会使运营费用重复增加」）。
- 未归集返点**独立成列，不摊给业务**（R5）。
- 回收与代挂账号纳入库存；提号只保留订单账号文本，不纳入库存（R1）。
"""
from __future__ import annotations

from ._shared import (
    REPORT_NAMES,
    ZERO,
    _apply_order_scope,
    _bad_debt_by_order,
    _bad_debt_rows,
    _event_contribution,
    _event_gain_cases,
    _event_offset_join,
    _event_totals,
    _money,
    _month_key,
    _sum_report_field,
    _validate_date_range,
    _visible_pool_ids,
)
from .export import finance_dimension_report, report_csv, report_for_export
from .funds import daily_funds_report
from .profit import order_profit_detail
from .r1_inventory import r1_inventory_health
from .r2_monthly_pnl import r2_monthly_pnl
from .r3_commission import r3_commission_reconciliation
from .r5_business_pnl import r5_business_pnl

__all__ = [
    "REPORT_NAMES",
    "ZERO",
    "_apply_order_scope",
    "_bad_debt_by_order",
    "_bad_debt_rows",
    "_event_contribution",
    "_event_gain_cases",
    "_event_offset_join",
    "_event_totals",
    "_money",
    "_month_key",
    "_sum_report_field",
    "_validate_date_range",
    "_visible_pool_ids",
    "daily_funds_report",
    "finance_dimension_report",
    "order_profit_detail",
    "report_csv",
    "report_for_export",
    "r1_inventory_health",
    "r2_monthly_pnl",
    "r3_commission_reconciliation",
    "r5_business_pnl",
]
