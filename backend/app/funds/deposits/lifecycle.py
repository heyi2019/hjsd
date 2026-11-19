"""押金生命周期：退还、取消、没收。"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any

from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import ErrorCode, Validation
from app.core.time import now_second
from app.core.money import to_money
from app.shared.numbering import allocate_flow_no
from app.shared.operation_operators import upsert_operation_operators
from app.core.security import CurrentUser
from app.domain.enums import (
    AccountingAttribute,
    AuditAction,
    CashflowSourceType,
    DepositStatus,
    Direction,
)
from app.domain.trade import Cashflow, Deposit
from app.shared.form_field_rules import validate_form_extra

from .._common import _positive, _text
from ._shared import (
    _assert_returnable,
    _can_see_pool,
    _deposit_not_found,
    _outstanding,
    _status_after_loss,
    _status_after_return,
)


def return_deposit(
    session: Session,
    deposit_id: int,
    *,
    amount: Any,
    released_on: date,
    form_extra: Mapping[str, Any] | None = None,
    actor: str,
    operator_user_ids: list[int] | None = None,
    user: CurrentUser | None = None,
) -> Deposit:
    deposit = session.get(Deposit, deposit_id)
    if deposit is None or not _can_see_pool(user, deposit.pool_id):
        raise _deposit_not_found(deposit_id)
    _assert_returnable(deposit, "退还")
    money = _positive(amount, field="amount")
    outstanding = _outstanding(deposit)
    if money > outstanding:
        raise Validation(
            "退还金额超过未释放余额",
            code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE,
            details={"deposit_id": deposit.id, "outstanding": str(outstanding)},
        )

    deposit.returned_amount = to_money(deposit.returned_amount) + money
    deposit.released_on = released_on
    deposit.status = _status_after_return(deposit)
    deposit.updated_by = actor
    if form_extra:
        deposit.form_extra = {**(deposit.form_extra or {}), **validate_form_extra(session, order_type_code="FUNDRELEASE", values=form_extra)}
    session.add(
        Cashflow(
            flow_no=allocate_flow_no(session, Direction.IN.value),
            pool_id=deposit.pool_id,
            occurred_on=released_on,
            ledger_type=deposit.ledger_type,
            accounting_attribute=AccountingAttribute.DEPOSIT.value,
            category="DEPOSIT_RELEASE",
            direction=Direction.IN.value,
            amount=money,
            order_id=deposit.source_order_id,
            source_type=CashflowSourceType.DEPOSIT.value,
            source_id=str(deposit.id),
            note="押金释放",
            created_by=actor,
            updated_by=actor,
        )
    )
    session.flush()
    record_audit(
        session,
        action=AuditAction.DEPOSIT_RELEASE,
        entity_type="deposit",
        entity_id=str(deposit.id),
        actor=actor,
        after={
            "returned": str(to_money(deposit.returned_amount)),
            "status": deposit.status,
        },
    )
    upsert_operation_operators(
        session,
        entity_type="deposit",
        entity_id=deposit.id,
        operation_key="RELEASE",
        actor=actor,
        operator_user_ids=operator_user_ids,
    )
    return deposit


def cancel_deposit(
    session: Session,
    deposit_id: int,
    *,
    cancelled_on: date,
    reason: str,
    form_extra: Mapping[str, Any] | None = None,
    actor: str,
    operator_user_ids: list[int] | None = None,
    user: CurrentUser | None = None,
) -> Deposit:
    """取消押金（CANCELLED）。守卫：仅未发生任何退还/损失的 PAID 押金可取消。

    语义：押金登记有误或租约取消且押金从未实际占用（如线下未收）。
    全额写一笔反向流水（DEPOSIT_CANCEL，方向 IN）把占用冲平，
    保证池内余额与押金台账始终勾稽。已发生退还/损失的走 return/loss。
    """
    deposit = session.get(Deposit, deposit_id)
    if deposit is None or not _can_see_pool(user, deposit.pool_id):
        raise _deposit_not_found(deposit_id)
    if deposit.status != DepositStatus.PAID.value or to_money(
        deposit.returned_amount
    ) > 0 or to_money(deposit.lost_amount) > 0:
        raise Validation(
            "只有未发生退还/损失的押金可取消",
            details={
                "deposit_id": deposit.id,
                "status": deposit.status,
                "returned_amount": str(deposit.returned_amount),
                "lost_amount": str(deposit.lost_amount),
            },
        )
    text = _text(reason, field="reason", message="取消押金必须填写理由")
    money = to_money(deposit.paid_amount)
    deposit.status = DepositStatus.CANCELLED.value
    # 反向流水 DEPOSIT_CANCEL（IN）已把资金余额冲平；台账侧同步回填已退金额，
    # 使「未释放余额 = 实缴 − 已退 − 已损失」与「在押合计」同归零，与流水勾稽。
    # 不回填会导致 CANCELLED 押金 outstanding 仍为实缴额，API 直调可再次释放重复入账。
    deposit.returned_amount = money
    deposit.released_on = cancelled_on
    deposit.updated_by = actor
    if form_extra:
        deposit.form_extra = {**(deposit.form_extra or {}), **validate_form_extra(session, order_type_code="FUNDCANCEL", values=form_extra)}
    session.add(
        Cashflow(
            flow_no=allocate_flow_no(session, Direction.IN.value),
            pool_id=deposit.pool_id,
            occurred_on=cancelled_on,
            ledger_type=deposit.ledger_type,
            accounting_attribute=AccountingAttribute.DEPOSIT.value,
            category="DEPOSIT_CANCEL",
            direction=Direction.IN.value,
            amount=money,
            order_id=deposit.source_order_id,
            source_type=CashflowSourceType.DEPOSIT.value,
            source_id=str(deposit.id),
            note=f"押金取消冲正：{text}"[:200],
            created_by=actor,
            updated_by=actor,
        )
    )
    session.flush()
    record_audit(
        session,
        action=AuditAction.DEPOSIT_CANCEL,
        entity_type="deposit",
        entity_id=str(deposit.id),
        actor=actor,
        before={"status": DepositStatus.PAID.value, "returned_amount": "0.00"},
        after={
            "status": deposit.status,
            "reversed_amount": str(money),
            "returned_amount": str(money),
        },
        reason=text,
    )
    upsert_operation_operators(
        session,
        entity_type="deposit",
        entity_id=deposit.id,
        operation_key="CANCEL",
        actor=actor,
        operator_user_ids=operator_user_ids,
    )
    return deposit


def lose_deposit(
    session: Session,
    deposit_id: int,
    *,
    amount: Any,
    lost_on: date,
    category: str,
    reason: str,
    form_extra: Mapping[str, Any] | None = None,
    actor: str,
    operator_user_ids: list[int] | None = None,
    user: CurrentUser | None = None,
) -> Cashflow:
    """把未释放押金转为受控运营费用，押金占用同步减少。"""
    deposit = session.get(Deposit, deposit_id)
    if deposit is None or not _can_see_pool(user, deposit.pool_id):
        raise _deposit_not_found(deposit_id)
    _assert_returnable(deposit, "登记损失")
    text_reason = _text(
        reason,
        field="reason",
        message="押金损失必须填写原因",
        type_message="押金损失必须填写原因",
    )
    label = _text(
        category,
        field="category",
        message="押金损失必须填写费用分类",
        uppercase=True,
        type_message="押金损失必须填写费用分类",
    )
    if label in {"DEPOSIT_HOLD", "DEPOSIT_RELEASE", "DEPOSIT_LOSS", "TRANSFER"}:
        raise Validation("押金损失费用分类不能使用系统分类", details={"field": "category"})
    money = _positive(amount, field="amount")
    outstanding = _outstanding(deposit)
    if money > outstanding:
        raise Validation(
            "损失金额超过未释放余额",
            code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE,
            details={"deposit_id": deposit.id, "outstanding": str(outstanding)},
        )
    deposit.lost_amount = to_money(deposit.lost_amount) + money
    deposit.lost_on = lost_on
    deposit.status = _status_after_loss(deposit)
    deposit.updated_by = actor
    flow = Cashflow(
        flow_no=allocate_flow_no(session, Direction.OUT.value),
        pool_id=deposit.pool_id,
        occurred_on=lost_on,
        ledger_type=deposit.ledger_type,
        accounting_attribute=AccountingAttribute.DEPOSIT.value,
        category=label,
        direction=Direction.OUT.value,
        amount=money,
        order_id=deposit.source_order_id,
        source_type=CashflowSourceType.DEPOSIT.value,
        source_id=str(deposit.id),
        reviewed_by=actor,
        reviewed_at=now_second(),
        note=text_reason,
        form_extra=validate_form_extra(session, order_type_code="FUNDLOSS", values=form_extra) or None,
        created_by=actor,
        updated_by=actor,
    )
    session.add(flow)
    session.flush()
    record_audit(
        session,
        action=AuditAction.DEPOSIT_LOSS,
        entity_type="deposit",
        entity_id=str(deposit.id),
        actor=actor,
        after={
            "amount": str(money),
            "category": label,
            "lost_amount": str(deposit.lost_amount),
            "status": deposit.status,
        },
        reason=text_reason,
    )
    upsert_operation_operators(
        session,
        entity_type="deposit",
        entity_id=deposit.id,
        operation_key="LOSS",
        actor=actor,
        operator_user_ids=operator_user_ids,
    )
    return flow
