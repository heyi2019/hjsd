"""现金方向与核算属性的业务映射。"""
from __future__ import annotations

from app.domain.enums import AccountingAttribute, Nature


def derive_manual_cashflow_nature(direction: str) -> str:
    """按收支方向生成手工流水的默认性质。"""
    return Nature.BUSINESS_OUT.value if direction.upper() == "OUT" else Nature.BUSINESS_IN.value


_ORDER_EVENT_ATTRIBUTES: dict[tuple[str, str], str] = {
    ("HS", "BUY"): AccountingAttribute.SELF_DIRECT_COST.value,
    ("HS", "SELL"): AccountingAttribute.SELF_REVENUE.value,
    ("HS", "CANCEL"): AccountingAttribute.REVERSAL.value,
    ("TH", "BUY"): AccountingAttribute.TH_DIRECT_COST.value,
    ("TH", "SELL"): AccountingAttribute.TH_REVENUE.value,
    ("TH", "CANCEL"): AccountingAttribute.REVERSAL.value,
    ("DG", "SELL"): AccountingAttribute.SERVICE_REVENUE.value,
    ("DG", "CANCEL"): AccountingAttribute.REVERSAL.value,
}


def accounting_attribute_for_order_event(
    order_type: str, event_type: str
) -> tuple[str, str]:
    """返回订单事件对应的核算属性。"""
    try:
        attribute = _ORDER_EVENT_ATTRIBUTES[(order_type.upper(), event_type.upper())]
    except KeyError as exc:
        raise ValueError(
            f"未定义订单事件核算属性: {order_type}/{event_type}"
        ) from exc
    return attribute


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
    "accounting_attribute_for_order_event",
    "accounting_attribute_for_manual_cashflow",
    "derive_manual_cashflow_nature",
]
