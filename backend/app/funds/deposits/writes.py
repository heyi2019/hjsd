"""押金写路径：创建、编辑和凭证保留。"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.money import to_money
from app.shared.numbering import allocate_flow_no
from app.shared.operation_operators import upsert_operation_operators
from app.core.security import CurrentUser
from app.domain.enums import (
    AccountingAttribute,
    AuditAction,
    CashflowLedgerType,
    CashflowSourceType,
    DepositStatus,
    Direction,
)
from app.domain.trade import Cashflow, Deposit
from app.settings.field_definitions.pools import assert_pool_usable
from app.shared.order_access import get_order
from app.shared.form_field_rules import merge_form_extra_for_edit, validate_form_extra
from app.customers.counterparties import assert_counterparty_usable

from .._common import _positive
from ._shared import (
    _can_see_pool,
    _deposit_actions,
    _locked_deposit,
    _normalize_ledger_type,
    _out_of_scope_error,
    _source_order_not_found,
)


# --------------------------------------------------------------------- 押金
def create_deposit(
    session: Session,
    *,
    pool_id: int,
    amount: Any,
    paid_on: date,
    actor: str,
    ledger_type: str = CashflowLedgerType.BUSINESS.value,
    counterparty_id: int | None = None,
    source_order_id: int | None = None,
    expected_release_on: date | None = None,
    note: str | None = None,
    form_extra: Mapping[str, Any] | None = None,
    operator_user_ids: list[int] | None = None,
    user: CurrentUser | None = None,
) -> Deposit:
    money = _positive(amount, field="amount")
    normalized_ledger_type = _normalize_ledger_type(
        ledger_type, source_order_id=source_order_id
    )
    if not _can_see_pool(user, pool_id):
        raise _out_of_scope_error(pool_id)
    pool = assert_pool_usable(session, pool_id)
    if counterparty_id is not None:
        assert_counterparty_usable(session, counterparty_id)
    if source_order_id is not None:
        try:
            get_order(session, source_order_id, user)
        except NotFound as exc:
            raise _source_order_not_found(source_order_id) from exc
    deposit = Deposit(
        pool_id=pool.id,
        ledger_type=normalized_ledger_type,
        counterparty_id=counterparty_id,
        source_order_id=source_order_id,
        paid_amount=money,
        returned_amount=Decimal("0"),
        lost_amount=Decimal("0"),
        status=DepositStatus.PAID.value,
        paid_on=paid_on,
        expected_release_on=expected_release_on,
        note=note,
        form_extra=validate_form_extra(
            session, order_type_code="FUNDDEPOSIT", values=form_extra,
            context={"pool_id": pool_id, "amount": amount, "paid_on": paid_on,
                     "ledger_type": ledger_type, "counterparty_id": counterparty_id,
                     "source_order_id": source_order_id, "expected_release_on": expected_release_on,
                     "note": note, "operator_user_ids": operator_user_ids},
        ) or None,
        created_by=actor,
        updated_by=actor,
    )
    session.add(deposit)
    session.flush()
    hold = Cashflow(
            flow_no=allocate_flow_no(session, Direction.OUT.value),
            pool_id=pool.id,
            occurred_on=paid_on,
            ledger_type=normalized_ledger_type,
            accounting_attribute=AccountingAttribute.DEPOSIT.value,
            category="DEPOSIT_HOLD",
            direction=Direction.OUT.value,
            amount=money,
            order_id=source_order_id,
            source_type=CashflowSourceType.DEPOSIT.value,
            source_id=str(deposit.id),
            note="押金占用",
            created_by=actor,
            updated_by=actor,
    )
    session.add(hold)
    session.flush()
    record_audit(
        session,
        action=AuditAction.DEPOSIT_CREATE,
        entity_type="deposit",
        entity_id=str(deposit.id),
        actor=actor,
        after={"pool": pool.code, "amount": str(money)},
    )
    operation = upsert_operation_operators(
        session,
        entity_type="deposit",
        entity_id=deposit.id,
        operation_key="CREATE",
        actor=actor,
        operator_user_ids=operator_user_ids,
        occurred_at=deposit.created_at,
    )
    hold.operator_user_ids = list(operation.operator_user_ids)
    session.flush()
    return deposit


def _editable_deposit(
    session: Session,
    deposit_id: int,
    *,
    user: CurrentUser | None = None,
) -> Deposit:
    deposit = _locked_deposit(session, deposit_id, user)
    if "EDIT" not in _deposit_actions(deposit):
        raise Validation(
            "只有未发生退还/损失的押金可编辑",
            details={
                "deposit_id": deposit.id,
                "status": deposit.status,
                "returned_amount": str(deposit.returned_amount),
                "lost_amount": str(deposit.lost_amount),
            },
        )
    return deposit


def update_deposit(
    session: Session,
    deposit_id: int,
    *,
    pool_id: int,
    amount: Any,
    paid_on: date,
    actor: str,
    ledger_type: str = CashflowLedgerType.BUSINESS.value,
    counterparty_id: int | None = None,
    source_order_id: int | None = None,
    expected_release_on: date | None = None,
    note: str | None = None,
    form_extra: Mapping[str, Any] | None = None,
    operator_user_ids: list[int] | None = None,
    user: CurrentUser | None = None,
) -> Deposit:
    deposit = _editable_deposit(session, deposit_id, user=user)
    money = _positive(amount, field="amount")
    normalized_ledger_type = _normalize_ledger_type(
        ledger_type, source_order_id=source_order_id
    )
    if not _can_see_pool(user, pool_id):
        raise _out_of_scope_error(pool_id)
    pool = assert_pool_usable(session, pool_id)
    if counterparty_id is not None:
        assert_counterparty_usable(session, counterparty_id)
    if source_order_id is not None:
        try:
            get_order(session, source_order_id, user)
        except NotFound as exc:
            raise _source_order_not_found(source_order_id) from exc

    hold = session.scalar(
        select(Cashflow).where(
            Cashflow.source_type == CashflowSourceType.DEPOSIT.value,
            Cashflow.source_id == str(deposit.id),
            Cashflow.category == "DEPOSIT_HOLD",
            Cashflow.direction == Direction.OUT.value,
        )
    )
    if hold is None:
        raise Validation("押金占用对应流水不存在，无法编辑", details={"deposit_id": deposit.id})

    effective_extra = merge_form_extra_for_edit(
        session, order_type_code="FUNDDEPOSIT", existing=deposit.form_extra, values=form_extra,
    )
    checked_extra = validate_form_extra(
        session, order_type_code="FUNDDEPOSIT",
        values=effective_extra,
        context={"pool_id": pool_id, "amount": amount, "paid_on": paid_on,
                 "ledger_type": ledger_type, "counterparty_id": counterparty_id,
                 "source_order_id": source_order_id, "expected_release_on": expected_release_on,
                 "note": note, "operator_user_ids": operator_user_ids},
    )
    before = {
        "pool_id": deposit.pool_id,
        "ledger_type": deposit.ledger_type,
        "amount": str(to_money(deposit.paid_amount)),
        "paid_on": deposit.paid_on.isoformat(),
        "counterparty_id": deposit.counterparty_id,
        "source_order_id": deposit.source_order_id,
        "expected_release_on": deposit.expected_release_on.isoformat() if deposit.expected_release_on else None,
        "note": deposit.note,
    }
    deposit.pool_id = pool.id
    deposit.ledger_type = normalized_ledger_type
    deposit.counterparty_id = counterparty_id
    deposit.source_order_id = source_order_id
    deposit.paid_amount = money
    deposit.paid_on = paid_on
    deposit.expected_release_on = expected_release_on
    deposit.note = note
    deposit.updated_by = actor
    deposit.form_extra = checked_extra or None

    hold.pool_id = pool.id
    hold.ledger_type = normalized_ledger_type
    hold.occurred_on = paid_on
    hold.amount = money
    hold.order_id = source_order_id
    hold.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.DEPOSIT_UPDATE,
        entity_type="deposit",
        entity_id=str(deposit.id),
        actor=actor,
        before=before,
        after={
            "pool_id": deposit.pool_id,
            "ledger_type": deposit.ledger_type,
            "amount": str(money),
            "paid_on": paid_on.isoformat(),
            "counterparty_id": counterparty_id,
            "source_order_id": source_order_id,
            "expected_release_on": expected_release_on.isoformat() if expected_release_on else None,
            "note": note,
        },
    )
    upsert_operation_operators(
        session,
        entity_type="deposit",
        entity_id=deposit.id,
        operation_key="UPDATE",
        actor=actor,
        operator_user_ids=operator_user_ids,
    )
    return deposit


def delete_deposit(
    session: Session,
    deposit_id: int,
    *,
    actor: str,
    user: CurrentUser | None = None,
) -> None:
    _locked_deposit(session, deposit_id, user)
    raise Validation("押金不能删除，请使用取消或退还处理", details={"deposit_id": deposit_id})
