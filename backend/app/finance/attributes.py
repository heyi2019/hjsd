"""现金方向与核算属性的业务映射。

订单事件核算属性映射已归位到 app/domain/cashflow_attributes.py（2026-11-18 P0-A，
orders / vas 双方引用 domain 不再有反向依赖）；本文件只保留 finance 域内的映射。
"""
from __future__ import annotations

from typing import Any

from app.core.errors import Validation
from app.domain.enums import AccountingAttribute, Nature

# ------------------------------------------------------------- 订单成本科目白名单
# （2026-11-18 口径：成本科目必须匹配订单类型——回收成本只归回收、提号成本只归提号；
# DG 与回收/提号同权但无专属成本科目，两种成本科目均禁用。）

COST_ATTRIBUTES_BY_ORDER_TYPE: dict[str, str] = {
    "HS": AccountingAttribute.SELF_DIRECT_COST.value,
    "TH": AccountingAttribute.TH_DIRECT_COST.value,
}

_COST_ATTRIBUTE_LABELS: dict[str, str] = {
    AccountingAttribute.SELF_DIRECT_COST.value: "回收成本",
    AccountingAttribute.TH_DIRECT_COST.value: "提号成本",
}


def assert_order_cost_attribute(order: Any, accounting_attribute: str) -> None:
    """挂单流水校验：成本科目必须与订单类型匹配（非成本科目不设限）。"""
    if accounting_attribute not in _COST_ATTRIBUTE_LABELS:
        return
    order_type = getattr(order, "order_type", None)
    if order_type not in COST_ATTRIBUTES_BY_ORDER_TYPE:
        raise Validation(
            "成本科目仅适用于回收/提号订单，代挂订单无成本科目",
            details={"field": "accounting_attribute", "order_type": order_type},
        )
    if COST_ATTRIBUTES_BY_ORDER_TYPE[order_type] != accounting_attribute:
        raise Validation(
            f"成本科目与订单类型不匹配：{_COST_ATTRIBUTE_LABELS[accounting_attribute]}"
            "不能挂在非对应类型订单上",
            details={"field": "accounting_attribute", "order_type": order_type},
        )

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

# 工作室口径：支出只认「运营消耗」，收入只认「回收收入」（SELF_REVENUE）——
# 两者是不同的归类，所以不能用一个属性过滤同时拿到两个方向。
STUDIO_EXPENSE_ATTRIBUTE = AccountingAttribute.OPERATING_EXPENSE.value
STUDIO_INCOME_ATTRIBUTE = AccountingAttribute.SELF_REVENUE.value


def derive_manual_cashflow_nature(direction: str) -> str:
    """按收支方向生成手工流水的默认性质。"""
    return Nature.BUSINESS_OUT.value if direction.upper() == "OUT" else Nature.BUSINESS_IN.value


def accounting_attribute_for_manual_cashflow(
    *, nature: str, category: str, direction: str, order_attached: bool = False
) -> str:
    """为独立录入流水提供保守的默认核算属性。

    挂单流水（order_attached=True）默认落「其他收入/其他支出」——
    工作室运营支出只属于工作室账簿，订单资金明细不得误标（2026-11-18 口径）。
    """
    if nature == Nature.INTERNAL.value or category == "TRANSFER":
        return AccountingAttribute.INTERNAL_TRANSFER.value
    if nature == "EXTERNAL_IN":
        return AccountingAttribute.EXTERNAL_FUNDING.value
    if category == "REBATE":
        return AccountingAttribute.REBATE_INCOME.value
    if category in {"DEPOSIT_HOLD", "DEPOSIT_RELEASE", "DEPOSIT_LOSS"}:
        return AccountingAttribute.DEPOSIT.value
    if category == "REVERSAL":
        return AccountingAttribute.REVERSAL.value
    if order_attached:
        return (
            AccountingAttribute.OTHER_INCOME.value
            if direction.upper() == "IN"
            else AccountingAttribute.OTHER_EXPENSE.value
        )
    return AccountingAttribute.OPERATING_EXPENSE.value


__all__ = [
    "COST_ATTRIBUTES_BY_ORDER_TYPE",
    "MANUAL_EXCLUDED_CATEGORIES",
    "STUDIO_EXPENSE_ATTRIBUTE",
    "STUDIO_INCOME_ATTRIBUTE",
    "assert_order_cost_attribute",
    "accounting_attribute_for_manual_cashflow",
    "derive_manual_cashflow_nature",
]
