"""分期按钮可用动作（available_actions）的后端唯一口径。

把原先散在前端 `contractColumns.tsx` 的 9 处状态/处置判定等价搬运到后端单点下发：
前端只回显本模块给出的动作 key，不再自行拼状态白名单数组。

写路径仍负责最终校验；列表操作应符合对应的合约状态限制。
"""
from __future__ import annotations

from typing import Iterable

from app.domain.enums import (
    InstallmentDispositionAction,
    InstallmentStatus,
    ScheduleStatus,
)
from ._shared import SCHEDULE_CLOSED_STATUSES

# 下发给前端的稳定动作 key（契约，勿随意改名）
PAY = "pay"
DELIVER = "deliver"
RECOVER = "recover"
CANCEL = "cancel"
SETTLE_EARLY = "settle_early"
DEFAULT = "default"
RESALE = "resale"
WAIVE = "waive"
EXTEND = "extend"

# 合约级：逐字对应改造前 contractColumns.tsx 的 disabled / 渲染条件
_PAY_BLOCKED = frozenset({
    InstallmentStatus.SETTLED.value,
    InstallmentStatus.DELIVERED.value,
    InstallmentStatus.CLOSED.value,
    InstallmentStatus.CANCELLED.value,
})  # disabled = status ∈ 此集合
_DELIVER_ALLOWED = frozenset({InstallmentStatus.SETTLED.value})  # disabled = status != SETTLED
_RECOVER_ALLOWED = frozenset({
    InstallmentStatus.OVERDUE.value,
    InstallmentStatus.DEFAULTED.value,
})  # 需 status ∈ 此集合，且无 RECOVER 处置
_CANCEL_ALLOWED = frozenset({
    InstallmentStatus.PENDING.value,
    InstallmentStatus.ACTIVE.value,
    InstallmentStatus.OVERDUE.value,
})  # disabled = status ∉ 此集合
_SETTLE_ALLOWED = frozenset(_CANCEL_ALLOWED)  # 与终止退款同口径
_DEFAULT_ALLOWED = frozenset({
    InstallmentStatus.OVERDUE.value,
})  # disabled = status ∉ 此集合
_RESALE_ALLOWED = frozenset({InstallmentStatus.CLOSED.value, *_RECOVER_ALLOWED})  # 需已有回收、无出售

# 期次级：仅看期次状态，与改造前一致（不额外看 received_amount）
_SCHEDULE_BLOCKED = frozenset({
    ScheduleStatus.PAID.value,
    ScheduleStatus.WAIVED.value,
})

_RECOVER_ACTION = InstallmentDispositionAction.RECOVER.value
_RESELL_ACTION = InstallmentDispositionAction.RESELL.value


def available_installment_actions(
    status: str, disposition_actions: Iterable[str]
) -> list[str]:
    """合约级可用动作（等价搬运前端 7 处判定）。

    返回顺序固定，前端只做 `includes` 判定，不依赖顺序。
    `disposition_actions` 为该合约已有处置记录 action 列表（RECOVER / RESELL）。
    """
    actions: list[str] = []
    if status not in _PAY_BLOCKED:
        actions.append(PAY)
    if status in _DELIVER_ALLOWED:
        actions.append(DELIVER)

    existing = set(disposition_actions)
    has_recover = _RECOVER_ACTION in existing
    has_resell = _RESELL_ACTION in existing
    if status in _RECOVER_ALLOWED and not has_recover:
        actions.append(RECOVER)
    if status in _CANCEL_ALLOWED:
        actions.append(CANCEL)
    if status in _SETTLE_ALLOWED:
        actions.append(SETTLE_EARLY)
    if status in _DEFAULT_ALLOWED:
        actions.append(DEFAULT)
    if status in _RESALE_ALLOWED and has_recover and not has_resell:
        actions.append(RESALE)
    return actions


def available_schedule_actions(status: str, contract_status: str | None = None) -> list[str]:
    """结束的合约及已完成的期次不允许减免或展期。"""
    if contract_status in SCHEDULE_CLOSED_STATUSES or status in _SCHEDULE_BLOCKED:
        return []
    return [WAIVE, EXTEND]


__all__ = [
    "PAY", "DELIVER", "RECOVER", "CANCEL", "SETTLE_EARLY", "DEFAULT",
    "RESALE", "WAIVE", "EXTEND",
    "available_installment_actions", "available_schedule_actions",
]
