"""订单事件核算属性映射（orders / finance / value_added_services 共享的领域知识）。

原在 app/finance/attributes.py；2026-11-18 P0-A 归位到 domain 层：
orders 落账（orders/events.py）、vas 分期收款（value_added_services/repayment.py）
都需要查询该映射，而 domain 是双方都合法引用的最低层——
归位后消灭 orders -> finance 的反向依赖（backend/.importlinter 契约随之收紧）。
"""
from __future__ import annotations

from app.domain.enums import AccountingAttribute

_ORDER_EVENT_ATTRIBUTES: dict[tuple[str, str], str] = {
    ("HS", "BUY"): AccountingAttribute.SELF_DIRECT_COST.value,
    ("HS", "SELL"): AccountingAttribute.SELF_REVENUE.value,
    ("HS", "CANCEL"): AccountingAttribute.REVERSAL.value,
    ("TH", "BUY"): AccountingAttribute.TH_DIRECT_COST.value,
    ("TH", "SELL"): AccountingAttribute.TH_REVENUE.value,
    ("TH", "CANCEL"): AccountingAttribute.REVERSAL.value,
    ("DG", "SELL"): AccountingAttribute.DG_REVENUE.value,
    ("DG", "CANCEL"): AccountingAttribute.REVERSAL.value,
}


def accounting_attribute_for_order_event(
    order_type: str, event_type: str
) -> str:
    """返回订单事件对应的核算属性。"""
    try:
        attribute = _ORDER_EVENT_ATTRIBUTES[(order_type.upper(), event_type.upper())]
    except KeyError as exc:
        raise ValueError(
            f"未定义订单事件核算属性: {order_type}/{event_type}"
        ) from exc
    return attribute


__all__ = ["accounting_attribute_for_order_event"]
