"""installments._shared：分期服务共用的数值校验、表单合并、期间推进与合约读取。
"""

from __future__ import annotations

from calendar import monthrange
from collections.abc import Mapping
from datetime import date
from decimal import Decimal
from typing import Any
from app.core.security import CurrentUser
from app.shared.scope import owner_scope_filter
from app.shared.form_field_rules import validate_form_extra
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import (
    NotFound,
    Validation,
)
from app.core.money import (
    require_non_negative,
    require_positive,
    to_money,
)
from app.core.state_machine import INSTALLMENT_TRANSITIONS, transition
from app.domain.trade import (
    Installment,
    InstallmentSchedule,
    Order,
)
from app.domain.enums import InstallmentStatus

SCHEDULE_CLOSED_STATUSES = frozenset({
    InstallmentStatus.CANCELLED.value,
    InstallmentStatus.CLOSED.value,
    InstallmentStatus.DELIVERED.value,
    InstallmentStatus.SETTLED.value,
})


def _restore_when_overdue_cleared(session: Session, installment: Installment) -> None:
    """最后一个逾期应收已消除时，按是否收款恢复正常合约状态。"""
    if installment.status != InstallmentStatus.OVERDUE.value:
        return
    session.flush()
    outstanding_overdue = session.scalar(
        select(InstallmentSchedule.id).where(
            InstallmentSchedule.installment_id == installment.id,
            InstallmentSchedule.due_on < date.today(),
            InstallmentSchedule.received_amount + InstallmentSchedule.waived_amount
            < InstallmentSchedule.due_amount,
        ).limit(1)
    )
    if outstanding_overdue is None:
        action = "RESUME_PAID" if to_money(installment.paid_amount) > 0 else "RESUME_UNPAID"
        installment.status = transition(INSTALLMENT_TRANSITIONS, installment.status, action, entity="分期合约")

def _non_negative(value: Any, *, field: str) -> Decimal:
    try:
        return require_non_negative(value, field=field)
    except ValueError as exc:
        raise Validation(str(exc), details={"field": field, "value": str(value)}) from exc


def _positive(value: Any, *, field: str) -> Decimal:
    try:
        return require_positive(value, field=field)
    except ValueError as exc:
        raise Validation(str(exc), details={"field": field, "value": str(value)}) from exc


def _required_text(value: Any, *, field: str, message: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise Validation(message, details={"field": field})
    return value.strip()


def _merge_form_extra(
    session: Session,
    installment: Installment,
    *,
    scope: str,
    values: Mapping[str, Any] | None,
    context: Mapping[str, Any] | None = None,
) -> None:
    checked = validate_form_extra(session, order_type_code=scope, values=values, context=context)
    if checked:
        installment.form_extra = {**(installment.form_extra or {}), **checked}


def _add_months(base: date, months: int) -> date:
    """按月推进到期日：`base + months` 个月，超出目标月天数时截断到月末。

    例：2026-01-31 + 1 个月 = 2026-02-28（闰年 29）。走标准库 calendar，
    不自己维护闰年与月末表，避免两者不一致导致到期日漂移。
    """
    total = base.month - 1 + months
    year = base.year + total // 12
    month = total % 12 + 1
    return date(year, month, min(base.day, monthrange(year, month)[1]))


def get_installment(
    session: Session, installment_id: int, user: CurrentUser | None = None, *, for_update: bool = False
) -> Installment:
    item = session.get(Installment, installment_id)
    if item is None:
        raise NotFound(
            f"分期合约 {installment_id} 不存在", details={"installment_id": installment_id}
        )
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        visible = session.scalar(
            select(Order.id).where(Order.id == item.order_id, scope)
        ) if scope is not None else True
        if not visible:
            raise NotFound(
                f"分期合约 {installment_id} 不存在",
                details={"installment_id": installment_id},
            )
    if for_update:
        item = session.execute(
            select(Installment).where(Installment.id == installment_id)
            .with_for_update().execution_options(populate_existing=True)
        ).scalar_one_or_none()
        if item is None:
            raise NotFound(f"分期合约 {installment_id} 不存在", details={"installment_id": installment_id})
    return item
