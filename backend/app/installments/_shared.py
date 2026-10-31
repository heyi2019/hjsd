"""installments._shared：分期服务共用的数值校验、表单合并、期间推进与合约读取。
"""

from __future__ import annotations

from calendar import monthrange
from collections.abc import Mapping
from datetime import date
from decimal import Decimal
from typing import Any
from app.core.security import CurrentUser
from app.core.security import owner_scope_filter
from app.orders.form_fields import validate_form_extra
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
from app.domain.trade import (
    Account,
    Installment,
    Order,
)

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
) -> None:
    if not values:
        return
    checked = validate_form_extra(session, order_type_code=scope, values=values)
    installment.form_extra = {**(installment.form_extra or {}), **checked}


def _materialize_dfq_recovery_account(
    session: Session,
    order: Order,
    *,
    actor: str,
) -> Account:
    """DFQ 回收转自营：使用建单时已入库的账号转为可售库存。"""
    if order.account_id is None:
        raise Validation("DFQ 分期没有关联库存账号")
    account = session.get(Account, order.account_id)
    if account is None:
        raise NotFound("分期合约关联账号不存在")
    account.business_mode = "SELF"
    account.inventory_type = "RECOVERY"
    account.value_added_service = None
    return account

def _add_months(base: date, months: int) -> date:
    """按月推进到期日：`base + months` 个月，超出目标月天数时截断到月末。

    例：2026-01-31 + 1 个月 = 2026-02-28（闰年 29）。走标准库 calendar，
    不自己维护闰年与月末表，避免两者不一致导致到期日漂移。
    """
    total = base.month - 1 + months
    year = base.year + total // 12
    month = total % 12 + 1
    return date(year, month, min(base.day, monthrange(year, month)[1]))


def total_receivable(installment: Installment) -> Decimal:
    return (
        to_money(installment.down_payment)
        + to_money(installment.per_period) * int(installment.periods)
        + to_money(installment.final_period_adjustment or 0)
        - to_money(installment.waived_amount)
    )

def get_installment(
    session: Session, installment_id: int, user: CurrentUser | None = None
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
    return item
