"""固定业务选项集的编码常量（不可编辑 OptionSet 的 code）。

归位理由：这些 code 既是所属业务域的字典键，又被设置页用于校验与置灰，
不属于任何单一业务域，符合 shared「跨域共享原语」判据。集中于此可避免
settings 反向依赖 business / workbench 形成环。
"""
from __future__ import annotations

COMPANY_PROFIT_CODE = "COMPANY_PROFIT_SHARE"
REMINDER_CODE = "BUSINESS_OVERVIEW_REMINDERS"

__all__ = ["COMPANY_PROFIT_CODE", "REMINDER_CODE"]
