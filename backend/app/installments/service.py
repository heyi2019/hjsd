"""installments.service：分期合约、期次计划、收款与交付（ACC-01 / HS-01-06 / DFQ-01）。

口径：
- `STOCK_SALE` 只允许已买入且在库的 HS 账号，**不新增 BUY**（A05）；
- `ADVANCE_PURCHASE` 只允许 DFQ（A04），两者不得混用；
- `PAYMENT` 是收入事实，产生现金流；`DELIVER` 无金额、无现金流；
- 应收 = 首付 + 期数 × 每期；已收由收款事件累计，不允许直接改。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.business_numbering import installment_no as order_installment_no
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.money import require_positive, to_money
from app.core.numbering import allocate_number
from app.core.state_machine import INSTALLMENT_TRANSITIONS, transition
from app.policy import service as policy_service
from app.domain.enums import (
    AccountStatus,
    AuditAction,
    DeliveryMode,
    EventType,
    InstallmentContractType,
    InstallmentStatus,
    PolicyType,
    ScheduleStatus,
    SequenceKey,
)
from app.domain.trade import Account, Installment, InstallmentSchedule, Order, OrderEvent
from app.orders import service as orders_service


def _add_months(base: date, months: int) -> date:
    """按月推进到期日（不引入第三方依赖）。"""
    total = base.month - 1 + months
    year = base.year + total // 12
    month = total % 12 + 1
    day = min(base.day, _days_in_month(year, month))
    return date(year, month, day)


def _days_in_month(year: int, month: int) -> int:
    if month == 12:
        return 31
    return (date(year, month + 1, 1) - date(year, month, 1)).days


def total_receivable(installment: Installment) -> Decimal:
    return to_money(installment.down_payment) + to_money(installment.per_period) * int(
        installment.periods
    )


def create_installment(
    session: Session,
    *,
    order_id: int,
    contract_type: str,
    principal: Any = 0,
    down_payment: Any = 0,
    service_fee: Any = 0,
    periods: int,
    per_period_service_fee: Any = 0,
    per_period: Any = 0,
    first_due_on: date,
    actor: str,
    account_id: int | None = None,
    delivery_mode: str | None = None,
    note: str | None = None,
    schedule: list[dict[str, Any]] | None = None,
) -> Installment:
    try:
        InstallmentContractType(contract_type)
    except ValueError as exc:
        raise Validation(
            f"合约类型必须为 {InstallmentContractType.values()}",
            code=ErrorCode.INSTALLMENT_TYPE_INVALID,
            details={"contract_type": contract_type},
        ) from exc

    order = orders_service.get_order(session, order_id)
    resolved_account_id = account_id if account_id is not None else order.account_id
    account = (
        session.get(Account, resolved_account_id) if resolved_account_id is not None else None
    )

    if contract_type == InstallmentContractType.STOCK_SALE.value:
        # HS 分期出售：账号必须已买入且在库。
        if order.order_type != "HS":
            raise Validation(
                "STOCK_SALE 只能用于 HS 订单",
                code=ErrorCode.INSTALLMENT_TYPE_INVALID,
                details={"order_no": order.order_no, "order_type": order.order_type},
            )
        has_buy_event = account is not None and session.scalar(
            select(OrderEvent.id).where(
                OrderEvent.order_id == order.id,
                OrderEvent.event_type == EventType.BUY.value,
                OrderEvent.is_posted.is_(True),
            )
        ) is not None
        if account is None or account.status != AccountStatus.IN_STOCK.value or not has_buy_event:
            raise Validation(
                "STOCK_SALE 要求账号已在库（已买入 HS）",
                code=ErrorCode.INSTALLMENT_TYPE_INVALID,
                details={"account_status": account.status if account else None},
            )
    elif contract_type == InstallmentContractType.ADVANCE_PURCHASE.value:
        if order.order_type != "DFQ":
            raise Validation(
                "ADVANCE_PURCHASE 只能用于 DFQ 订单",
                code=ErrorCode.INSTALLMENT_TYPE_INVALID,
                details={"order_no": order.order_no, "order_type": order.order_type},
            )

    existing = session.scalar(
        select(Installment).where(Installment.order_id == order.id)
    )
    if existing is not None:
        raise Conflict(
            f"订单 {order.order_no} 已存在分期合约 {existing.inst_no}",
            code=ErrorCode.INSTALLMENT_TYPE_INVALID,
            details={"inst_no": existing.inst_no},
        )
    if periods <= 0:
        raise Validation("期数必须大于 0", details={"field": "periods", "value": periods})

    schedule_dates: dict[int, date] = {}
    for item in schedule or []:
        period_no = int(item["period_no"])
        if period_no < 1 or period_no > periods or period_no in schedule_dates:
            raise Validation("分期计划期次必须从 1 开始且不能重复", details={"period_no": period_no})
        schedule_dates[period_no] = item["due_on"]

    if delivery_mode is not None:
        try:
            DeliveryMode(delivery_mode)
        except ValueError as exc:
            raise Validation(
                f"交付方式必须为 {DeliveryMode.values()}",
                code=ErrorCode.DELIVERY_CONDITION_UNMET,
                details={"delivery_mode": delivery_mode},
            ) from exc

    # BAS-06-04：签约日固化分期规则（期数/首付/利率），改版不影响历史合约
    policy_version_id, policy_snapshot = policy_service.make_snapshot(
        session, policy_code=PolicyType.INSTALLMENT.value, on=first_due_on or date.today()
    )
    installment = Installment(
        inst_no=order_installment_no(order.order_no),
        order_id=order.id,
        account_id=account.id if account else None,
        contract_type=contract_type,
        policy_version_id=policy_version_id,
        policy_snapshot=policy_snapshot,
        principal=to_money(principal),
        down_payment=to_money(down_payment),
        service_fee=to_money(service_fee),
        periods=periods,
        per_period_service_fee=to_money(per_period_service_fee),
        per_period=to_money(per_period),
        paid_amount=Decimal("0"),
        status=InstallmentStatus.PENDING.value,
        first_due_on=first_due_on,
        delivery_mode=delivery_mode,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(installment)
    session.flush()

    # 首付为期次 0，其后按期递增
    session.add(
        InstallmentSchedule(
            installment_id=installment.id,
            period_no=0,
            due_on=first_due_on,
            due_amount=to_money(down_payment),
            received_amount=Decimal("0"),
            status=ScheduleStatus.PENDING.value,
        )
    )
    for index in range(1, periods + 1):
        session.add(
            InstallmentSchedule(
                installment_id=installment.id,
                period_no=index,
                due_on=schedule_dates.get(index, _add_months(first_due_on, index - 1)),
                due_amount=to_money(per_period),
                received_amount=Decimal("0"),
                status=ScheduleStatus.PENDING.value,
            )
        )
    session.flush()

    if account is not None:
        account.status = AccountStatus.INSTALLMENT.value

    record_audit(
        session,
        action=AuditAction.INSTALLMENT_CREATE,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        after={
            "order_no": order.order_no,
            "contract_type": contract_type,
            "total_receivable": str(total_receivable(installment)),
        },
    )
    return installment


def get_installment(session: Session, installment_id: int) -> Installment:
    item = session.get(Installment, installment_id)
    if item is None:
        raise NotFound(
            f"分期合约 {installment_id} 不存在", details={"installment_id": installment_id}
        )
    return item


def list_installments(
    session: Session, *, status: str | None = None, order_id: int | None = None
) -> list[Installment]:
    stmt = select(Installment)
    if status:
        stmt = stmt.where(Installment.status == status)
    if order_id:
        stmt = stmt.where(Installment.order_id == order_id)
    return list(session.scalars(stmt.order_by(Installment.id)).all())


def pay(
    session: Session,
    installment_id: int,
    *,
    amount: Any,
    paid_on: date,
    period_no: int | None = None,
    actor: str,
    pool_id: int | None = None,
    note: str | None = None,
) -> tuple[Installment, InstallmentSchedule]:
    """收款：`PAYMENT` 是收入事实，派生现金流并累计已收（DFQ-01-04/05）。"""
    installment = get_installment(session, installment_id)
    if installment.status in (
        InstallmentStatus.CANCELLED.value,
        InstallmentStatus.DELIVERED.value,
    ):
        raise Conflict(
            f"合约 {installment.inst_no} 状态 {installment.status}，不可收款",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"inst_no": installment.inst_no, "status": installment.status},
        )

    money = require_positive(amount, field="amount")
    remaining_total = total_receivable(installment) - to_money(installment.paid_amount)
    if money > remaining_total:
        raise Validation(
            "收款金额超过剩余应收",
            code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE,
            details={
                "inst_no": installment.inst_no,
                "remaining": str(remaining_total),
                "amount": str(money),
            },
        )

    schedule = _pick_schedule(session, installment, period_no, paid_on)
    outstanding = to_money(schedule.due_amount) - to_money(schedule.received_amount)
    if money > outstanding:
        raise Validation(
            f"第 {schedule.period_no} 期剩余应收 {outstanding}",
            code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE,
            details={"period_no": schedule.period_no, "outstanding": str(outstanding)},
        )

    schedule.received_amount = to_money(schedule.received_amount) + money
    schedule.received_on = paid_on
    schedule.status = (
        ScheduleStatus.PAID.value
        if schedule.received_amount >= schedule.due_amount
        else ScheduleStatus.PARTIAL.value
    )
    installment.paid_amount = to_money(installment.paid_amount) + money

    orders_service.post_event(
        session,
        installment.order_id,
        event_type=EventType.PAYMENT.value,
        amount=money,
        occurred_on=paid_on,
        actor=actor,
        pool_id=pool_id,
        portion="PROFIT",
        note=note or f"分期收款 {installment.inst_no} 第 {schedule.period_no} 期",
    )

    if installment.status == InstallmentStatus.PENDING.value:
        installment.status = transition(
            INSTALLMENT_TRANSITIONS, installment.status, "PAYMENT", entity="分期合约"
        )
    if to_money(installment.paid_amount) >= total_receivable(installment):
        installment.status = InstallmentStatus.SETTLED.value
    session.flush()

    record_audit(
        session,
        action=AuditAction.INSTALLMENT_PAYMENT,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        after={
            "period_no": schedule.period_no,
            "amount": str(money),
            "paid_total": str(to_money(installment.paid_amount)),
            "status": installment.status,
        },
    )
    return installment, schedule


def _pick_schedule(
    session: Session, installment: Installment, period_no: int | None, paid_on: date
) -> InstallmentSchedule:
    if period_no is not None:
        schedule = session.scalar(
            select(InstallmentSchedule).where(
                InstallmentSchedule.installment_id == installment.id,
                InstallmentSchedule.period_no == period_no,
            )
        )
        if schedule is None:
            raise NotFound(
                f"期次 {period_no} 不存在", details={"period_no": period_no}
            )
        return schedule
    # 未指定期次：按到期日顺序取第一笔未收满的期次
    schedule = session.scalars(
        select(InstallmentSchedule)
        .where(
            InstallmentSchedule.installment_id == installment.id,
            InstallmentSchedule.received_amount < InstallmentSchedule.due_amount,
        )
        .order_by(InstallmentSchedule.period_no)
    ).first()
    if schedule is None:
        raise Validation(
            "所有期次已收满", code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE
        )
    return schedule


def deliver(
    session: Session,
    installment_id: int,
    *,
    delivery_mode: str,
    delivered_on: date,
    note: str,
    actor: str,
) -> Installment:
    """换绑交付：只能从 `SETTLED` 进入，生成无金额 `DELIVER`（DFQ-01-07 / A04 / A05）。"""
    installment = get_installment(session, installment_id)
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

    orders_service.post_event(
        session,
        installment.order_id,
        event_type=EventType.DELIVER.value,
        occurred_on=delivered_on,
        actor=actor,
        delivery_mode=delivery_mode,
        note=note,
    )
    installment.status = transition(
        INSTALLMENT_TRANSITIONS, installment.status, "DELIVER", entity="分期合约"
    )
    installment.delivery_mode = delivery_mode
    installment.delivered_on = delivered_on
    session.flush()
    record_audit(
        session,
        action=AuditAction.DELIVER_CREATE,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        after={"delivery_mode": delivery_mode, "delivered_on": delivered_on.isoformat()},
    )
    return installment


def mark_overdue(session: Session, *, as_of: date, actor: str = "system") -> int:
    """按到期日实时标记逾期；已收满的期次不标记（DFQ-01-06）。"""
    rows = session.scalars(
        select(InstallmentSchedule).where(
            InstallmentSchedule.due_on < as_of,
            InstallmentSchedule.received_amount < InstallmentSchedule.due_amount,
            InstallmentSchedule.status != ScheduleStatus.OVERDUE.value,
        )
    ).all()
    count = 0
    for row in rows:
        row.status = ScheduleStatus.OVERDUE.value
        count += 1
    if rows:
        installment_ids = {row.installment_id for row in rows}
        for installment_id in installment_ids:
            installment = session.get(Installment, installment_id)
            if installment and installment.status == InstallmentStatus.ACTIVE.value:
                installment.status = InstallmentStatus.OVERDUE.value
    session.flush()
    return count


__all__ = [
    "create_installment",
    "deliver",
    "get_installment",
    "list_installments",
    "mark_overdue",
    "pay",
    "total_receivable",
]
