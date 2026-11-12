"""finance 押金服务（FIN-04）：缴纳、退还、取消、没收与查询。"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import ErrorCode, NotFound, Validation
from app.core.time import now_second
from app.core.money import to_money
from app.core.numbering import allocate_flow_no
from app.core.security import CurrentUser
from app.domain.enums import (
    AccountingAttribute,
    AuditAction,
    CashflowStatus,
    DepositStatus,
    Direction,
    FundNature,
    Nature,
)
from app.domain.trade import Cashflow, Deposit
from app.foundation import service as foundation_service
from app.orders._shared import get_order
from app.orders.form_fields import validate_form_extra
from app.parties import service as parties_service

from ._common import _positive, _text

# --------------------------------------------------------------------- 押金
def create_deposit(
    session: Session,
    *,
    pool_id: int,
    amount: Any,
    paid_on: date,
    actor: str,
    counterparty_id: int | None = None,
    source_order_id: int | None = None,
    expected_release_on: date | None = None,
    note: str | None = None,
    form_extra: Mapping[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> Deposit:
    money = _positive(amount, field="amount")
    if user is not None and not user.can_see_pool(pool_id):
        raise NotFound("资金池不存在", details={"pool_id": pool_id})
    pool = foundation_service.assert_pool_usable(session, pool_id)
    if counterparty_id is not None:
        parties_service.assert_counterparty_usable(session, counterparty_id)
    if source_order_id is not None:
        try:
            get_order(session, source_order_id, user)
        except NotFound as exc:
            raise NotFound(
                f"来源订单 {source_order_id} 不存在",
                details={"source_order_id": source_order_id},
            ) from exc
    deposit = Deposit(
        pool_id=pool.id,
        counterparty_id=counterparty_id,
        source_order_id=source_order_id,
        paid_amount=money,
        returned_amount=Decimal("0"),
        lost_amount=Decimal("0"),
        status=DepositStatus.PAID.value,
        paid_on=paid_on,
        expected_release_on=expected_release_on,
        note=note,
        form_extra=validate_form_extra(session, order_type_code="FUNDDEPOSIT", values=form_extra) or None,
        created_by=actor,
        updated_by=actor,
    )
    session.add(deposit)
    session.flush()
    session.add(
        Cashflow(
            flow_no=allocate_flow_no(session, Direction.OUT.value),
            pool_id=pool.id,
            occurred_on=paid_on,
            nature=Nature.BUSINESS_OUT.value,
            fund_nature=FundNature.EXTERNAL.value,
            accounting_attribute=AccountingAttribute.DEPOSIT.value,
            category="DEPOSIT_HOLD",
            direction=Direction.OUT.value,
            amount=money,
            order_id=source_order_id,
            deposit_id=deposit.id,
            note="押金占用",
            created_by=actor,
            updated_by=actor,
        )
    )
    session.flush()
    record_audit(
        session,
        action=AuditAction.DEPOSIT_CREATE,
        entity_type="deposit",
        entity_id=str(deposit.id),
        actor=actor,
        after={"pool": pool.code, "amount": str(money)},
    )
    return deposit


def return_deposit(
    session: Session,
    deposit_id: int,
    *,
    amount: Any,
    released_on: date,
    form_extra: Mapping[str, Any] | None = None,
    actor: str,
    user: CurrentUser | None = None,
) -> Deposit:
    deposit = session.get(Deposit, deposit_id)
    if deposit is None:
        raise NotFound(f"押金 {deposit_id} 不存在", details={"deposit_id": deposit_id})
    if user is not None and not user.can_see_pool(deposit.pool_id):
        raise NotFound(f"押金 {deposit_id} 不存在", details={"deposit_id": deposit_id})
    money = _positive(amount, field="amount")
    outstanding = (
        to_money(deposit.paid_amount)
        - to_money(deposit.returned_amount)
        - to_money(deposit.lost_amount)
    )
    if money > outstanding:
        raise Validation(
            "退还金额超过未释放余额",
            code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE,
            details={"deposit_id": deposit.id, "outstanding": str(outstanding)},
        )

    deposit.returned_amount = to_money(deposit.returned_amount) + money
    deposit.released_on = released_on
    if to_money(deposit.returned_amount) + to_money(deposit.lost_amount) >= to_money(
        deposit.paid_amount
    ):
        deposit.status = (
            DepositStatus.LOST.value
            if to_money(deposit.lost_amount) > 0
            else DepositStatus.RETURNED.value
        )
    else:
        deposit.status = DepositStatus.PARTIALLY_RETURNED.value
    deposit.updated_by = actor
    if form_extra:
        deposit.form_extra = {**(deposit.form_extra or {}), **validate_form_extra(session, order_type_code="FUNDRELEASE", values=form_extra)}
    session.add(
        Cashflow(
            flow_no=allocate_flow_no(session, Direction.IN.value),
            pool_id=deposit.pool_id,
            occurred_on=released_on,
            nature=Nature.BUSINESS_IN.value,
            fund_nature=FundNature.EXTERNAL.value,
            accounting_attribute=AccountingAttribute.DEPOSIT.value,
            category="DEPOSIT_RELEASE",
            direction=Direction.IN.value,
            amount=money,
            order_id=deposit.source_order_id,
            deposit_id=deposit.id,
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
    return deposit


def cancel_deposit(
    session: Session,
    deposit_id: int,
    *,
    cancelled_on: date,
    reason: str,
    form_extra: Mapping[str, Any] | None = None,
    actor: str,
    user: CurrentUser | None = None,
) -> Deposit:
    """取消押金（CANCELLED）。守卫：仅未发生任何退还/损失的 PAID 押金可取消。

    语义：押金登记有误或租约取消且押金从未实际占用（如线下未收）。
    全额写一笔反向流水（DEPOSIT_CANCEL，方向 IN）把占用冲平，
    保证池内余额与押金台账始终勾稽。已发生退还/损失的走 return/loss。
    """
    deposit = session.get(Deposit, deposit_id)
    if deposit is None or (user is not None and not user.can_see_pool(deposit.pool_id)):
        raise NotFound(f"押金 {deposit_id} 不存在", details={"deposit_id": deposit_id})
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
    deposit.released_on = cancelled_on
    deposit.updated_by = actor
    if form_extra:
        deposit.form_extra = {**(deposit.form_extra or {}), **validate_form_extra(session, order_type_code="FUNDCANCEL", values=form_extra)}
    session.add(
        Cashflow(
            flow_no=allocate_flow_no(session, Direction.IN.value),
            pool_id=deposit.pool_id,
            occurred_on=cancelled_on,
            nature=Nature.BUSINESS_IN.value,
            fund_nature=FundNature.EXTERNAL.value,
            accounting_attribute=AccountingAttribute.DEPOSIT.value,
            category="DEPOSIT_CANCEL",
            direction=Direction.IN.value,
            amount=money,
            order_id=deposit.source_order_id,
            deposit_id=deposit.id,
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
        before={"status": DepositStatus.PAID.value},
        after={"status": deposit.status, "reversed_amount": str(money)},
        reason=text,
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
    user: CurrentUser | None = None,
) -> Cashflow:
    """把未释放押金转为受控运营费用，押金占用同步减少。"""
    deposit = session.get(Deposit, deposit_id)
    if deposit is None or (user is not None and not user.can_see_pool(deposit.pool_id)):
        raise NotFound(f"押金 {deposit_id} 不存在", details={"deposit_id": deposit_id})
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
    outstanding = (
        to_money(deposit.paid_amount)
        - to_money(deposit.returned_amount)
        - to_money(deposit.lost_amount)
    )
    if money > outstanding:
        raise Validation(
            "损失金额超过未释放余额",
            code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE,
            details={"deposit_id": deposit.id, "outstanding": str(outstanding)},
        )
    deposit.lost_amount = to_money(deposit.lost_amount) + money
    deposit.lost_on = lost_on
    if (
        to_money(deposit.returned_amount) + to_money(deposit.lost_amount)
        >= to_money(deposit.paid_amount)
    ):
        deposit.status = DepositStatus.LOST.value
    deposit.updated_by = actor
    flow = Cashflow(
        flow_no=allocate_flow_no(session, Direction.OUT.value),
        pool_id=deposit.pool_id,
        occurred_on=lost_on,
        nature=Nature.BUSINESS_OUT.value,
        fund_nature=FundNature.EXTERNAL.value,
        accounting_attribute=AccountingAttribute.DEPOSIT.value,
        category=label,
        direction=Direction.OUT.value,
        amount=money,
        order_id=deposit.source_order_id,
        deposit_id=deposit.id,
        status=CashflowStatus.APPROVED.value,
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
    return flow


def list_deposits(
    session: Session,
    *,
    pool_id: int | None = None,
    pool_ids: Iterable[int] | None = None,
    user: CurrentUser | None = None,
) -> list[Deposit]:
    stmt = select(Deposit)
    if pool_id is not None:
        if user is not None and not user.can_see_pool(pool_id):
            return []
        stmt = stmt.where(Deposit.pool_id == pool_id)
    elif pool_ids is not None:
        visible_pool_ids = list(pool_ids)
        if user is not None and not (user.is_admin or user.owner_scope == "ALL"):
            visible_pool_ids = [pool for pool in visible_pool_ids if user.can_see_pool(pool)]
        stmt = stmt.where(Deposit.pool_id.in_(visible_pool_ids))
    elif user is not None and not (user.is_admin or user.owner_scope == "ALL"):
        stmt = stmt.where(Deposit.pool_id.in_(sorted(user.pool_ids)))
    return list(session.scalars(stmt.order_by(Deposit.id)).all())


def deposit_held_total(
    session: Session, pool_id: int | None = None
) -> Decimal:
    """在押押金合计 = Σ(实缴 − 已退 − 已损失)，可按池过滤。

    与 `PoolBalanceOut.deposit_held` 信息列同源；占用已进资金池 OUT，
    此值仅作台账展示，不参与可用余额二次扣减。
    """
    stmt = select(
        func.coalesce(
            func.sum(Deposit.paid_amount - Deposit.returned_amount - Deposit.lost_amount),
            0,
        )
    )
    if pool_id:
        stmt = stmt.where(Deposit.pool_id == pool_id)
    return to_money(session.scalar(stmt) or 0)
