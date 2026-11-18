"""押金领域共享原语：派生规则、账簿归一化、可见性与错误工厂。

被 writes / lifecycle / reads 三个子模块共同引用，自身不依赖任何子模块。
"""
from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal

from app.core.errors import NotFound, Validation
from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.enums import CashflowLedgerType, DepositStatus
from app.domain.trade import Deposit


# ------------------------------------------------------------ 押金派生规则（单一来源）
def _outstanding(deposit: Deposit) -> Decimal:
    """未释放余额 = 实缴 − 已退 − 已损失（退还/没收共用同一口径）。"""
    return (
        to_money(deposit.paid_amount)
        - to_money(deposit.returned_amount)
        - to_money(deposit.lost_amount)
    )


def _status_after_return(deposit: Deposit) -> str:
    """退还后的状态派生：全额释放看有无损失，否则部分退还。"""
    if to_money(deposit.returned_amount) + to_money(deposit.lost_amount) >= to_money(
        deposit.paid_amount
    ):
        return (
            DepositStatus.LOST.value
            if to_money(deposit.lost_amount) > 0
            else DepositStatus.RETURNED.value
        )
    return DepositStatus.PARTIALLY_RETURNED.value


def _status_after_loss(deposit: Deposit) -> str:
    """没收后的状态派生：仅全额损失时才转 LOST，部分损失保持原状态。"""
    if (
        to_money(deposit.returned_amount) + to_money(deposit.lost_amount)
        >= to_money(deposit.paid_amount)
    ):
        return DepositStatus.LOST.value
    return deposit.status


def _normalize_ledger_type(ledger_type: str, *, source_order_id: int | None) -> str:
    """押金账簿归一化：BUSINESS 业务押金 / STUDIO 工作室运营押金。

    工作室押金不属于订单，强制要求 `source_order_id` 为空；业务押金保持现有自由度
    （可挂合作方/平台，也可选挂来源订单）。口径与资金流水 `ledger_type` 同源。
    """
    try:
        normalized = CashflowLedgerType(ledger_type).value
    except ValueError as exc:
        raise Validation(
            f"押金账簿必须为 {CashflowLedgerType.values()}",
            details={"field": "ledger_type", "value": ledger_type},
        ) from exc
    if normalized == CashflowLedgerType.STUDIO.value and source_order_id is not None:
        raise Validation(
            "工作室运营押金不能挂来源订单",
            details={"field": "source_order_id", "value": source_order_id},
        )
    return normalized


def _can_see_pool(user: CurrentUser | None, pool_id: int) -> bool:
    """可见性谓词：无用户约束或用户可见该池时为 True。"""
    return user is None or user.can_see_pool(pool_id)


def _is_scope_all(user: CurrentUser | None) -> bool:
    """用户是否不受池范围约束（管理员或 owner_scope=ALL）。"""
    return user is None or user.is_admin or user.owner_scope == "ALL"


def _visible_pool_ids(user: CurrentUser | None, pool_ids: Iterable[int]) -> list[int]:
    """按用户池范围过滤候选池 ID（list_deposits 用）。"""
    ids = list(pool_ids)
    if _is_scope_all(user):
        return ids
    return [pool for pool in ids if user.can_see_pool(pool)]  # type: ignore[union-attr]


def _out_of_scope_error(pool_id: int) -> NotFound:
    return NotFound("资金账户不存在", details={"pool_id": pool_id})


def _deposit_not_found(deposit_id: int) -> NotFound:
    return NotFound(f"押金 {deposit_id} 不存在", details={"deposit_id": deposit_id})


def _source_order_not_found(order_id: int) -> NotFound:
    return NotFound(
        f"来源订单 {order_id} 不存在", details={"source_order_id": order_id}
    )
