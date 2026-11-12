"""资金性质、现金方向和核算属性的业务映射。"""
from __future__ import annotations

from app.domain.enums import AccountingAttribute, FundNature


_ALLOWED_ATTRIBUTES_BY_FUND_NATURE: dict[str, frozenset[str]] = {
    FundNature.BUSINESS.value: frozenset({
        AccountingAttribute.SELF_REVENUE.value,
        AccountingAttribute.SELF_DIRECT_COST.value,
        AccountingAttribute.TH_DIRECT_COST.value,
        AccountingAttribute.TH_REVENUE.value,
        AccountingAttribute.SERVICE_REVENUE.value,
        AccountingAttribute.ADDITIONAL_INCOME.value,
        AccountingAttribute.ADDITIONAL_EXPENSE.value,
        AccountingAttribute.OPERATING_EXPENSE.value,
        AccountingAttribute.REVERSAL.value,
        AccountingAttribute.REFUND.value,
    }),
    FundNature.EXTERNAL.value: frozenset({
        AccountingAttribute.DEPOSIT.value,
        AccountingAttribute.EXTERNAL_FUNDING.value,
        AccountingAttribute.REVERSAL.value,
    }),
    FundNature.INTERNAL.value: frozenset({AccountingAttribute.INTERNAL_TRANSFER.value}),
}


def validate_fund_accounting_attribute(fund_nature: str, accounting_attribute: str) -> None:
    """确保资金性质与核算属性属于同一核算层。"""
    allowed = _ALLOWED_ATTRIBUTES_BY_FUND_NATURE.get(fund_nature)
    if allowed is None or accounting_attribute not in allowed:
        raise ValueError(
            f"资金性质与核算属性不匹配: {fund_nature}/{accounting_attribute}"
        )


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
    """返回订单事件对应的（资金性质、核算属性）。"""
    try:
        attribute = _ORDER_EVENT_ATTRIBUTES[(order_type.upper(), event_type.upper())]
    except KeyError as exc:
        raise ValueError(
            f"未定义订单事件核算属性: {order_type}/{event_type}"
        ) from exc
    return FundNature.BUSINESS.value, attribute


def accounting_attributes_for_manual_cashflow(
    *, nature: str, category: str, direction: str
) -> tuple[str, str]:
    """为独立录入流水提供保守的默认属性。"""
    if nature == FundNature.INTERNAL.value or category == "TRANSFER":
        return FundNature.INTERNAL.value, AccountingAttribute.INTERNAL_TRANSFER.value
    if nature == "EXTERNAL_IN":
        return FundNature.EXTERNAL.value, AccountingAttribute.EXTERNAL_FUNDING.value
    if category in {"REBATE", "REBATE_REVERSAL"}:
        attribute = (
            AccountingAttribute.REVERSAL.value
            if category == "REBATE_REVERSAL"
            else AccountingAttribute.ADDITIONAL_INCOME.value
        )
        return FundNature.BUSINESS.value, attribute
    if category in {"DEPOSIT_HOLD", "DEPOSIT_RELEASE", "DEPOSIT_LOSS"}:
        return FundNature.EXTERNAL.value, AccountingAttribute.DEPOSIT.value
    if category == "REVERSAL":
        return FundNature.BUSINESS.value, AccountingAttribute.REVERSAL.value
    return FundNature.BUSINESS.value, AccountingAttribute.OPERATING_EXPENSE.value


__all__ = [
    "accounting_attribute_for_order_event",
    "accounting_attributes_for_manual_cashflow",
    "validate_fund_accounting_attribute",
]
