"""押金领域共享原语：派生规则、账簿归一化、可见性与错误工厂。

被 writes / lifecycle / reads 三个子模块共同引用，自身不依赖任何子模块。
"""
from __future__ import annotations

from decimal import Decimal
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound, Validation
from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.enums import CashflowLedgerType, DepositStatus
from app.domain.trade import Deposit
from app.shared.order_access import lock_order_reference


# ------------------------------------------------------------ 押金派生规则（单一来源）
def deposit_available_actions(
    status: str, paid_amount: Decimal, returned_amount: Decimal, lost_amount: Decimal,
) -> list[str]:
    """由后端统一决定押金的业务动作，写入时仍重新加锁校验。"""
    paid = to_money(paid_amount)
    returned = to_money(returned_amount)
    lost = to_money(lost_amount)
    actions: list[str] = []
    if status == DepositStatus.PAID.value and returned <= 0 and lost <= 0:
        actions.extend(("EDIT", "CANCEL"))
    if status in (DepositStatus.PAID.value, DepositStatus.PARTIALLY_RETURNED.value) and paid - returned - lost > 0:
        actions.extend(("RETURN", "LOSS"))
    return actions


def _deposit_actions(deposit: Deposit) -> list[str]:
    return deposit_available_actions(
        deposit.status, deposit.paid_amount, deposit.returned_amount, deposit.lost_amount,
    )


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


def _assert_returnable(deposit: Deposit, action: str) -> None:
    """退还/损失动作的状态守卫：仅未结清押金可再操作。

    CANCELLED 押金由 cancel_deposit 写反向流水（DEPOSIT_CANCEL）冲平，已视为结清；
    RETURNED/LOST 是终态。前端靠按钮 disabled 挡住正常点击，但 API 可被直调，
    故服务端必须拦截，否则 CANCELLED 押金可再次释放造成重复入账。
    """
    if "RETURN" not in _deposit_actions(deposit):
        raise Validation(
            f"{action}仅适用于未结清的押金",
            details={"deposit_id": deposit.id, "status": deposit.status},
        )


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


def _out_of_scope_error(pool_id: int) -> NotFound:
    return NotFound("资金账户不存在", details={"pool_id": pool_id})


def _deposit_not_found(deposit_id: int) -> NotFound:
    return NotFound(f"押金 {deposit_id} 不存在", details={"deposit_id": deposit_id})


def _locked_deposit(session: Session, deposit_id: int, user: CurrentUser | None) -> Deposit:
    """先锁来源订单，再锁押金，避免与订单日期平移的锁顺序相反。"""
    current = session.execute(
        select(Deposit.pool_id, Deposit.source_order_id).where(Deposit.id == deposit_id)
    ).one_or_none()
    if current is None or not _can_see_pool(user, current.pool_id):
        raise _deposit_not_found(deposit_id)
    if current.source_order_id is not None:
        lock_order_reference(session, current.source_order_id)
    deposit = session.get(Deposit, deposit_id, with_for_update=True, populate_existing=True)
    if deposit is None or not _can_see_pool(user, deposit.pool_id):
        raise _deposit_not_found(deposit_id)
    if deposit.source_order_id != current.source_order_id:
        raise Conflict("押金来源订单已变化，请刷新后重试")
    return deposit


def _source_order_not_found(order_id: int) -> NotFound:
    return NotFound(
        f"来源订单 {order_id} 不存在", details={"source_order_id": order_id}
    )
