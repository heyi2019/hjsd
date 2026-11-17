"""现金方向与核算属性的业务映射。

订单事件核算属性映射已归位到 app/domain/cashflow_attributes.py（2026-11-18 P0-A，
orders / vas 双方引用 domain 不再有反向依赖）；本文件只保留 finance 域内的映射。
"""
from __future__ import annotations

from app.domain.enums import AccountingAttribute, Nature

# ------------------------------------------------------------- 工作室口径常量
# （2026-11-18 P2 从 cashflows.py 归位：写路径与查询层共用，属会计口径知识）

# 与 `list_cashflows` 里 source 判定「大体」一致：这几种 category（或挂了押金/事件/划转）
# 都不是「手工登记」，不计入工作室收支。改这里必须同步那段 if/elif。
# 唯一有意不等价处：挂了 order_id 的普通资金流水在列表里 source 仍是 OTHER，
# 但它属于订单资金明细而非工作室手工收支，故 _studio_scope 额外排除 order_id。
MANUAL_EXCLUDED_CATEGORIES: tuple[str, ...] = (
    "REBATE",
    "DEPOSIT_HOLD",
    "DEPOSIT_RELEASE",
    "DEPOSIT_LOSS",
    "TRANSFER",
)

# 工作室口径：支出只认「运营消耗」，收入只认「自营收入」——两者是不同的归类，
# 所以不能用一个属性过滤同时拿到两个方向。
STUDIO_EXPENSE_ATTRIBUTE = AccountingAttribute.OPERATING_EXPENSE.value
STUDIO_INCOME_ATTRIBUTE = AccountingAttribute.SELF_REVENUE.value


def derive_manual_cashflow_nature(direction: str) -> str:
    """按收支方向生成手工流水的默认性质。"""
    return Nature.BUSINESS_OUT.value if direction.upper() == "OUT" else Nature.BUSINESS_IN.value


def accounting_attribute_for_manual_cashflow(
    *, nature: str, category: str, direction: str
) -> str:
    """为独立录入流水提供保守的默认核算属性。"""
    if nature == Nature.INTERNAL.value or category == "TRANSFER":
        return AccountingAttribute.INTERNAL_TRANSFER.value
    if nature == "EXTERNAL_IN":
        return AccountingAttribute.EXTERNAL_FUNDING.value
    if category == "REBATE":
        attribute = AccountingAttribute.ADDITIONAL_INCOME.value
        return attribute
    if category in {"DEPOSIT_HOLD", "DEPOSIT_RELEASE", "DEPOSIT_LOSS"}:
        return AccountingAttribute.DEPOSIT.value
    if category == "REVERSAL":
        return AccountingAttribute.REVERSAL.value
    return AccountingAttribute.OPERATING_EXPENSE.value


__all__ = [
    "MANUAL_EXCLUDED_CATEGORIES",
    "STUDIO_EXPENSE_ATTRIBUTE",
    "STUDIO_INCOME_ATTRIBUTE",
    "accounting_attribute_for_manual_cashflow",
    "derive_manual_cashflow_nature",
]
