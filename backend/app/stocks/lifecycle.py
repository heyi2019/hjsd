"""账号资产生命周期命令。

交易履约域可以发起账号状态变更，但账号状态、成本和库存生命周期的实际
变更由本模块统一执行，避免订单事件、分期和取消流程各自直接改模型。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.core.errors import Validation
from app.core.money import to_money
from app.core.state_machine import ACCOUNT_TRANSITIONS, transition
from app.domain.enums import InventoryType
from app.domain.trade import Account


def _non_negative_amount(value: Decimal) -> Decimal:
    amount = to_money(value)
    if amount < 0:
        raise Validation("账号资产变更金额不能为负数", details={"amount": str(value)})
    return amount


def apply_account_event_effect(
    account: Account,
    *,
    event_type: str,
    amount: Decimal,
    stock_type: bool,
    buy_date: date | None = None,
    offset_event_type: str | None = None,
    cancel_fully_consumed: bool = True,
    actor: str | None = None,
) -> Account:
    """应用订单事件对账号资产的成本和生命周期影响。"""
    money = _non_negative_amount(amount)
    if event_type == "BUY":
        account.cost_amount = to_money(account.cost_amount) + money
        if buy_date is not None:
            account.buy_date = buy_date
        next_action = "BUY_STOCK" if stock_type else "BUY_CREDIT"
        target = ACCOUNT_TRANSITIONS.get(account.status, {}).get(next_action)
        if target is not None:
            account.status = target
    elif event_type == "COST":
        account.cost_amount = to_money(account.cost_amount) + money
    elif event_type == "SELL":
        account.status = transition(ACCOUNT_TRANSITIONS, account.status, "SELL", entity="账号")
    elif event_type == "CANCEL":
        apply_cancellation_effect(
            account,
            money,
            offset_event_type=offset_event_type,
            cancel_fully_consumed=cancel_fully_consumed,
            actor=actor,
        )
        return account
    if actor is not None:
        account.updated_by = actor
    return account


def apply_cancellation_effect(
    account: Account,
    amount: Decimal,
    *,
    offset_event_type: str | None,
    cancel_fully_consumed: bool,
    actor: str | None,
) -> Account:
    """应用订单事件冲销对账号库存和成本的影响。"""
    if offset_event_type == "SELL":
        if cancel_fully_consumed:
            action = (
                "CANCEL_SELL_END"
                if account.inventory_type == InventoryType.PICKUP.value
                else "CANCEL_SELL"
            )
            account.status = transition(ACCOUNT_TRANSITIONS, account.status, action, entity="账号")
    elif offset_event_type == "PAYMENT":
        # 分期收款取消只产生原路退款资金流，不改写账号成本或库存状态。
        pass
    else:
        account.cost_amount = to_money(account.cost_amount) - amount
        if offset_event_type is None or (
            offset_event_type == "BUY" and cancel_fully_consumed
        ):
            account.status = transition(ACCOUNT_TRANSITIONS, account.status, "VOID", entity="账号")
    if actor is not None:
        account.updated_by = actor
    return account


def mark_delivered(
    account: Account,
    *,
    actor: str,
    bound_phone: str | None = None,
) -> Account:
    """确认账号交付，并由资产域更新账号生命周期。"""
    if bound_phone is not None:
        account.bound_phone = bound_phone
    account.status = "SOLD"
    account.updated_by = actor
    return account


def apply_installment_cancellation(
    account: Account,
    *,
    contract_type: str,
    actor: str,
) -> Account:
    """分期合约终止后的账号回流/终止。"""
    action = "CANCEL_SELL_END" if contract_type == "PICKUP_SALE" else "CANCEL_STOCK"
    account.status = transition(ACCOUNT_TRANSITIONS, account.status, action, entity="账号")
    account.updated_by = actor
    return account


def retire_for_plain_cancel(
    account: Account,
    *,
    actor: str,
) -> Account:
    """取消无事件订单时，将仅由该订单创建的账号退出库存。"""
    if ACCOUNT_TRANSITIONS.get(account.status, {}).get("VOID") is not None:
        account.status = transition(ACCOUNT_TRANSITIONS, account.status, "VOID", entity="账号")
        account.updated_by = actor
    return account


__all__ = [
    "apply_account_event_effect",
    "apply_cancellation_effect",
    "apply_installment_cancellation",
    "mark_delivered",
    "retire_for_plain_cancel",
]
