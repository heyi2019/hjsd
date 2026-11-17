"""installments.recovery：账号回收、回收出售登记、处置流水、交付与逾期标记（BAS-03）。
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from datetime import date
from decimal import Decimal
from typing import Any
from app.shared.audit import record_audit
from app.core.security import CurrentUser
from app.shared.scope import owner_scope_filter
from app.orders.events import post_event
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import (
    Conflict,
    ErrorCode,
    NotFound,
    Validation,
)
from app.core.money import to_money
from app.shared.operation_operators import upsert_operation_operators
from app.core.state_machine import (
    ACCOUNT_TRANSITIONS,
    INSTALLMENT_TRANSITIONS,
    transition,
)
from app.domain.enums import (
    AuditAction,
    DeliveryMode,
    EventType,
    InstallmentDispositionAction,
    InstallmentStatus,
    ScheduleStatus,
)
from app.domain.trade import (
    Account,
    Installment,
    InstallmentDisposition,
    InstallmentSchedule,
    Order,
    OrderEvent,
)

from ._shared import (
    _merge_form_extra,
    _required_text,
    get_installment,
    total_receivable,
)

def recover_account(
    session: Session,
    installment_id: int,
    *,
    occurred_on: date,
    actor: str,
    note: str,
    form_extra: Mapping[str, Any] | None = None,
    operator_user_ids: list[int] | None = None,
    user: CurrentUser | None = None,
) -> InstallmentDisposition:
    """登记账号回收并关闭原分期，不改写原分期应收。"""
    text_note = _required_text(note, field="note", message="回收必须填写说明")
    installment = get_installment(session, installment_id, user)
    _merge_form_extra(session, installment, scope="INSTRECOVER", values=form_extra)
    if installment.status not in {
        InstallmentStatus.OVERDUE.value,
        InstallmentStatus.DEFAULTED.value,
    }:
        raise Validation("只有逾期或违约合约可以回收账号")
    order = session.get(Order, installment.order_id)
    if order is None:
        raise Validation("分期合约没有所属订单")
    if order.account_id is None:
        raise Validation("分期合约没有可回收的账号")
    account = session.get(Account, order.account_id)
    if account is None:
        raise NotFound("分期合约关联账号不存在")
    existing = session.scalar(
        select(InstallmentDisposition).where(
            InstallmentDisposition.installment_id == installment.id,
            InstallmentDisposition.action == InstallmentDispositionAction.RECOVER.value,
        )
    )
    if existing is not None:
        raise Conflict("该分期合约已登记回收")
    account.status = transition(
        ACCOUNT_TRANSITIONS, account.status, "RECOVER", entity="账号"
    )
    account.updated_by = actor
    installment.status = transition(
        INSTALLMENT_TRANSITIONS, installment.status, "CLOSE", entity="分期合约"
    )
    installment.bad_debt_amount = max(
        Decimal("0"),
        total_receivable(installment) - to_money(installment.paid_amount),
    )
    installment.updated_by = actor
    disposition = InstallmentDisposition(
        installment_id=installment.id,
        account_id=account.id,
        action=InstallmentDispositionAction.RECOVER.value,
        occurred_on=occurred_on,
        note=text_note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(disposition)
    session.flush()
    record_audit(
        session,
        action=AuditAction.INSTALLMENT_RECOVER,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        after={
            "account_id": account.id,
            "occurred_on": occurred_on.isoformat(),
            "status": installment.status,
            "bad_debt_amount": str(to_money(installment.bad_debt_amount)),
        },
        reason=text_note,
    )
    upsert_operation_operators(
        session,
        entity_type="installment",
        entity_id=installment.inst_no,
        operation_key="RECOVER",
        actor=actor,
        operator_user_ids=operator_user_ids,
        occurred_at=None,
    )
    return disposition


def record_sale(
    session: Session,
    installment_id: int,
    *,
    sale_order_id: int,
    occurred_on: date,
    actor: str,
    note: str,
    form_extra: Mapping[str, Any] | None = None,
    operator_user_ids: list[int] | None = None,
    user: CurrentUser | None = None,
) -> InstallmentDisposition:
    """登记回收账号的出售订单，并保留原分期与出售订单的利润关联。"""
    text_note = _required_text(note, field="note", message="出售必须填写说明")
    installment = get_installment(session, installment_id, user)
    _merge_form_extra(session, installment, scope="INSTRESALE", values=form_extra)
    if installment.status not in {
        InstallmentStatus.CLOSED.value,
        InstallmentStatus.OVERDUE.value,
        InstallmentStatus.DEFAULTED.value,
    }:
        raise Validation("只有已关闭、逾期或违约合约可以登记出售")
    original_order = session.get(Order, installment.order_id)
    sale_order = session.get(Order, sale_order_id)
    if original_order is None or original_order.account_id is None:
        raise Validation("分期合约没有可出售的账号")
    if sale_order is None or sale_order.id == original_order.id:
        raise Validation("出售必须关联新的售出订单")
    if sale_order.account_id != original_order.account_id:
        raise Validation("出售订单必须关联同一个账号")
    recovered = session.scalar(
        select(InstallmentDisposition).where(
            InstallmentDisposition.installment_id == installment.id,
            InstallmentDisposition.action == InstallmentDispositionAction.RECOVER.value,
        )
    )
    if recovered is None:
        raise Validation("出售前必须先登记回收")
    posted_sell = session.scalar(
        select(OrderEvent.id).where(
            OrderEvent.order_id == sale_order.id,
            OrderEvent.event_type == EventType.SELL.value,
            OrderEvent.is_posted.is_(True),
        )
    )
    if posted_sell is None:
        raise Validation("出售订单必须先登记 SELL 事件")
    existing = session.scalar(
        select(InstallmentDisposition).where(
            InstallmentDisposition.installment_id == installment.id,
            InstallmentDisposition.action == InstallmentDispositionAction.RESELL.value,
        )
    )
    if existing is not None:
        raise Conflict("该分期合约已登记出售")
    disposition = InstallmentDisposition(
        installment_id=installment.id,
        account_id=original_order.account_id,
        action=InstallmentDispositionAction.RESELL.value,
        occurred_on=occurred_on,
        related_order_id=sale_order.id,
        note=text_note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(disposition)
    session.flush()
    record_audit(
        session,
        action=AuditAction.INSTALLMENT_RESELL,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        after={"account_id": original_order.account_id, "sale_order_id": sale_order.id},
        reason=text_note,
    )
    upsert_operation_operators(
        session,
        entity_type="installment",
        entity_id=installment.inst_no,
        operation_key="RESELL",
        actor=actor,
        operator_user_ids=operator_user_ids,
    )
    return disposition


def list_dispositions(
    session: Session,
    installment_id: int,
    user: CurrentUser | None = None,
) -> list[InstallmentDisposition]:
    """返回分期账号处置历史，按发生时间和登记顺序排列。"""
    installment = get_installment(session, installment_id, user)
    return list(
        session.scalars(
            select(InstallmentDisposition)
            .where(InstallmentDisposition.installment_id == installment.id)
            .order_by(InstallmentDisposition.occurred_on, InstallmentDisposition.id)
        ).all()
    )


def deliver(
    session: Session,
    installment_id: int,
    *,
    delivery_mode: str,
    delivered_on: date,
    note: str,
    bound_phone: str | None = None,
    bound_phone_owner: str | None = None,
    form_extra: Mapping[str, Any] | None = None,
    actor: str,
    operator_user_ids: list[int] | None = None,
    user: CurrentUser | None = None,
) -> Installment:
    """换绑交付：只能从 `SETTLED` 进入，生成无金额 `DELIVER`（A04 / A05）。"""
    installment = get_installment(session, installment_id, user)
    _merge_form_extra(session, installment, scope="INSTDELIVER", values=form_extra)
    if installment.status != InstallmentStatus.SETTLED.value:
        raise Validation(
            f"合约 {installment.inst_no} 未结清（{installment.status}），不可换绑交付",
            code=ErrorCode.DELIVERY_CONDITION_UNMET,
            details={"inst_no": installment.inst_no, "status": installment.status},
        )
    try:
        DeliveryMode(delivery_mode)
    except ValueError as exc:
        raise Validation(
            f"交付方式必须为 {DeliveryMode.values()}",
            code=ErrorCode.DELIVERY_CONDITION_UNMET,
            details={"delivery_mode": delivery_mode},
        ) from exc
    if not note:
        raise Validation(
            "交付必须记录换绑凭证", code=ErrorCode.DELIVERY_CONDITION_UNMET,
            details={"field": "note"},
        )

    post_event(
        session,
        installment.order_id,
        event_type=EventType.DELIVER.value,
        occurred_on=delivered_on,
        actor=actor,
        delivery_mode=delivery_mode,
        note=note,
        bound_phone=bound_phone,
        bound_phone_owner=bound_phone_owner,
        form_extra=form_extra,
        operator_user_ids=operator_user_ids,
        user=user,
        allow_installment_delivery=True,
    )
    installment.status = transition(
        INSTALLMENT_TRANSITIONS, installment.status, "DELIVER", entity="分期合约"
    )
    installment.delivery_mode = delivery_mode
    installment.delivered_on = delivered_on
    installment.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.DELIVER_CREATE,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        after={"delivery_mode": delivery_mode, "delivered_on": delivered_on.isoformat()},
    )
    upsert_operation_operators(
        session,
        entity_type="installment",
        entity_id=installment.inst_no,
        operation_key="DELIVER",
        actor=actor,
        operator_user_ids=operator_user_ids,
    )
    return installment


def mark_overdue(
    session: Session,
    *,
    as_of: date,
    actor: str = "system",
    user: CurrentUser | None = None,
) -> int:
    """按到期日实时标记逾期；已收满的期次不标记。"""
    stmt = (
        select(InstallmentSchedule)
        .join(Installment, Installment.id == InstallmentSchedule.installment_id)
        .join(Order, Order.id == Installment.order_id)
        .where(
            Installment.status.in_(
                (
                    InstallmentStatus.PENDING.value,
                    InstallmentStatus.ACTIVE.value,
                    InstallmentStatus.OVERDUE.value,
                )
            ),
            InstallmentSchedule.due_on < as_of,
            InstallmentSchedule.received_amount + InstallmentSchedule.waived_amount
            < InstallmentSchedule.due_amount,
            InstallmentSchedule.status != ScheduleStatus.OVERDUE.value,
        )
    )
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    rows = session.scalars(stmt).all()
    count = len(rows)
    for row in rows:
        row.status = ScheduleStatus.OVERDUE.value
    if rows:
        # 一次性统计每个合约本次被标记的期数：原实现在合约循环里再扫一遍全量 rows，
        # 是 O(合约数 × 期次数)；Counter 单趟线性。
        overdue_counts = Counter(row.installment_id for row in rows)
        # 一次性预取涉及的合约，避免在循环里逐条 session.get（N+1）。
        installments = {
            item.id: item
            for item in session.scalars(
                select(Installment).where(Installment.id.in_(overdue_counts))
            ).all()
        }
        for installment_id, overdue_periods in overdue_counts.items():
            installment = installments.get(installment_id)
            if installment and installment.status in {
                InstallmentStatus.PENDING.value,
                InstallmentStatus.ACTIVE.value,
            }:
                installment.status = transition(
                    INSTALLMENT_TRANSITIONS,
                    installment.status,
                    "MARK_OVERDUE",
                    entity="分期合约",
                )
                installment.updated_by = actor
                record_audit(
                    session,
                    action=AuditAction.INSTALLMENT_OVERDUE,
                    entity_type="installment",
                    entity_id=installment.inst_no,
                    actor=actor,
                    after={
                        "status": installment.status,
                        "as_of": as_of.isoformat(),
                        "overdue_periods": overdue_periods,
                    },
                )
    session.flush()
    return count
