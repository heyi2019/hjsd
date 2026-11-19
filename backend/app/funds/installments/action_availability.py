"""分期按钮可用动作（available_actions）的后端唯一口径。

把原先散在前端 `contractColumns.tsx` 的 9 处状态/处置判定等价搬运到后端单点下发：
前端只回显本模块给出的动作 key，不再自行拼状态白名单数组。

口径来源：刻意复刻**前端历史判定**（等价于改造前的线上行为），不是写路径守卫。
二者存在已知差异（recover 放行 CLOSED、default 放行 ACTIVE、settle 仅三态、
pay 拦 SETTLED/CLOSED），本次改造要求行为零变化，故不做修正。写路径守卫仍是
服务端最终防线——本模块回答「按钮能不能点」，写路径守卫回答「请求能不能过」，
职责不同。若要统一二者口径属另一次业务裁决，不在本模块进行。
"""
from __future__ import annotations

from typing import Iterable

from app.domain.enums import (
    InstallmentDispositionAction,
    InstallmentStatus,
    ScheduleStatus,
)

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
    InstallmentStatus.CLOSED.value,
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
    InstallmentStatus.ACTIVE.value,
    InstallmentStatus.OVERDUE.value,
})  # disabled = status ∉ 此集合
_RESALE_ALLOWED = frozenset(_RECOVER_ALLOWED)  # 需 status ∈ 此集合，且有 RECOVER、无 RESELL

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
    """期次级可用动作（等价搬运前端 waive/extend 两处判定）。

    仅看期次 status；PAID / WAIVED 不可减免展期，其余一律可用。
    """
    if contract_status == InstallmentStatus.CANCELLED.value or status in _SCHEDULE_BLOCKED:
        return []
    return [WAIVE, EXTEND]


__all__ = [
    "PAY", "DELIVER", "RECOVER", "CANCEL", "SETTLE_EARLY", "DEFAULT",
    "RESALE", "WAIVE", "EXTEND",
    "available_installment_actions", "available_schedule_actions",
]
