"""现金方向与核算属性的业务映射。

订单事件核算属性映射已归位到 app/domain/cashflow_attributes.py（2026-11-18 P0-A，
orders / vas 双方引用 domain 不再有反向依赖）；本文件只保留 finance 域内的映射。
"""
from __future__ import annotations

from app.domain.enums import AccountingAttribute, Nature


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
    "accounting_attribute_for_manual_cashflow",
    "derive_manual_cashflow_nature",
]
