"""installments.service：分期合约、期次计划、收款与交付（ACC-01 / HS-01-06 / DFQ-01）。

口径：
    - `STOCK_SALE` 只允许已买入且在库的 HS 账号，**不新增 BUY**（A05）；
    - `ADVANCE_PURCHASE` 只允许 DFQ（A04）；
    - `PICKUP_SALE` 只允许 TH，`CONSIGNMENT_SALE` 只允许 DG；
- `PAYMENT` 是收入事实，产生现金流；`DELIVER` 无金额、无现金流；
- 应收 = 首付 + 期数 × 每期；已收由收款事件累计，不允许直接改。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from collections.abc import Mapping
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session
from pydantic import ValidationError as PydanticValidationError

from app.core.audit import record_audit
from app.core.business_numbering import installment_no as order_installment_no
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.money import require_non_negative, require_positive, to_money
from app.core.security import CurrentUser, owner_scope_filter
from app.core.numbering import allocate_number
from app.core.state_machine import ACCOUNT_TRANSITIONS, INSTALLMENT_TRANSITIONS, ORDER_TRANSITIONS, transition
from app.policy import service as policy_service
from app.domain.enums import (
    AccountStatus,
    AuditAction,
    DeliveryMode,
    EventType,
    InstallmentContractType,
    InstallmentDispositionAction,
    InstallmentStatus,
    PolicyType,
    ScheduleStatus,
    SequenceKey,
)
from app.domain.trade import (
    Account,
    Installment,
    InstallmentDisposition,
    InstallmentSchedule,
    Order,
    OrderEvent,
    OrderProfitAllocation,
)
from app.domain.users import User
from app.accounts import service as accounts_service
from app.foundation import service as foundation_service
from app.orders import service as orders_service
from app.orders.amounts import order_amounts
from app.installments.schemas import ScheduleCreate
from app.parties import service as parties_service


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


def _materialize_dfq_recovery_account(
    session: Session,
    order: Order,
    *,
    actor: str,
) -> Account:
    """DFQ 原本只存账号快照；首次回收时把资产快照转为可售库存账号。"""
    snapshot = order.account_snapshot or {}
    game_account = snapshot.get("game_account")
    if not isinstance(game_account, str) or not game_account.strip():
        raise Validation("DFQ 分期缺少可回收的账号资料")
    existing = session.scalar(
        select(Account).where(Account.game_account == game_account.strip())
    )
    if existing is not None:
        raise Conflict(
            f"账号 {game_account.strip()} 已存在，不能从 DFQ 快照重复建库存账号"
        )
    account = accounts_service.create_account(
        session,
        game_account=game_account,
        game_type=snapshot.get("game_type"),
        business_mode="SELF",
        inventory_type="RECOVERY",
        game_password=snapshot.get("game_password"),
        channel_region=snapshot.get("channel_region"),
        bound_phone=snapshot.get("bound_phone"),
        has_secondary=snapshot.get("has_secondary"),
        platform=snapshot.get("platform"),
        note=snapshot.get("note"),
        actor=actor,
    )
    historical_cost = sum(
        (
            event.amount
            for event in session.scalars(
                select(OrderEvent).where(
                    OrderEvent.order_id == order.id,
                    OrderEvent.event_type.in_({EventType.BUY.value, EventType.COST.value}),
                    OrderEvent.is_posted.is_(True),
                )
            ).all()
        ),
        Decimal("0"),
    )
    account.cost_amount = to_money(historical_cost)
    account.buy_date = order.trade_date if historical_cost > 0 else None
    account.status = AccountStatus.INSTALLMENT.value
    account.updated_by = actor
    order.account_id = account.id
    order.updated_by = actor
    session.flush()
    return account


def link_recovered_sale(
    session: Session,
    order: Order,
    *,
    occurred_on: date,
    actor: str,
    note: str | None = None,
) -> InstallmentDisposition | None:
    """把回收账号的新出售事实关联到最近一笔未转售的原分期。"""
    if order.account_id is None:
        return None
    candidates = session.scalars(
        select(InstallmentDisposition)
        .join(Installment, Installment.id == InstallmentDisposition.installment_id)
        .where(
            InstallmentDisposition.account_id == order.account_id,
            InstallmentDisposition.action == InstallmentDispositionAction.RECOVER.value,
            Installment.order_id != order.id,
        )
        .order_by(InstallmentDisposition.occurred_on.desc(), InstallmentDisposition.id.desc())
    ).all()
    recovered = next(
        (
            candidate
            for candidate in candidates
            if session.scalar(
                select(InstallmentDisposition.id).where(
                    InstallmentDisposition.installment_id == candidate.installment_id,
                    InstallmentDisposition.action == InstallmentDispositionAction.RESELL.value,
                )
            ) is None
        ),
        None,
    )
    if recovered is None:
        return None
    disposition = InstallmentDisposition(
        installment_id=recovered.installment_id,
        account_id=order.account_id,
        action=InstallmentDispositionAction.RESELL.value,
        occurred_on=occurred_on,
        related_order_id=order.id,
        note=note or f"库存中心出售自动关联订单 {order.order_no}",
        created_by=actor,
        updated_by=actor,
    )
    session.add(disposition)
    session.flush()
    installment = session.get(Installment, recovered.installment_id)
    record_audit(
        session,
        action=AuditAction.INSTALLMENT_RESELL,
        entity_type="installment",
        entity_id=installment.inst_no if installment is not None else str(recovered.installment_id),
        actor=actor,
        after={"account_id": order.account_id, "sale_order_id": order.id},
        reason=disposition.note,
    )
    return disposition


def _normalize_schedule(schedule: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if not schedule:
        return []
    try:
        return [
            item.model_dump()
            for item in (ScheduleCreate.model_validate(raw) for raw in schedule)
        ]
    except PydanticValidationError as exc:
        raise Validation(
            "分期计划字段校验失败",
            details={
                "field": "schedule",
                "errors": [
                    {
                        "field": ".".join(str(part) for part in error["loc"]),
                        "message": error["msg"],
                    }
                    for error in exc.errors()
                ],
            },
        ) from exc


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
    return (
        to_money(installment.down_payment)
        + to_money(installment.per_period) * int(installment.periods)
        + to_money(installment.final_period_adjustment or 0)
        - to_money(installment.waived_amount)
    )


def _service_fee_from_snapshot(
    session: Session,
    snapshot: dict[str, Any] | None,
    order: Any,
    principal: Decimal,
) -> Decimal:
    """按 INSTALLMENT 规则补算服务费（仅在入参 service_fee 省略时调用）。

    - 规则没有 service_fee_rate：返回 0，保持「不收服务费」的既有默认。
    - 基数 config.base：PRINCIPAL（默认）取本金；GROSS 取订单卖出收入合计；
      其它值直接报错，不静默回退——「配了却按别的基数算钱」比报错更危险。
    """
    if not snapshot:
        return Decimal("0")
    config = snapshot.get("config")
    if not isinstance(config, dict):
        return Decimal("0")
    raw_rate = config.get("service_fee_rate")
    if raw_rate is None:
        return Decimal("0")
    try:
        rate = to_money(raw_rate)
    except ValueError as exc:
        raise Validation(
            "分期规则中的服务费率必须是数值",
            details={"field": "config.service_fee_rate", "value": str(raw_rate)},
        ) from exc
    if rate > Decimal("100.00"):
        raise Validation(
            "分期服务费率必须在 0% 到 100% 之间",
            details={"field": "config.service_fee_rate", "value": str(rate)},
        )
    base_kind = str(config.get("base") or "PRINCIPAL").strip().upper()
    if base_kind == "PRINCIPAL":
        base = principal
    elif base_kind == "GROSS":
        base = order_amounts(session, order.id)["GROSS"]
    else:
        raise Validation(
            f"分期服务费基数不支持 {base_kind}（仅 PRINCIPAL / GROSS）",
            details={"field": "config.base", "value": base_kind},
        )
    return (base * rate / Decimal("100")).quantize(Decimal("0.01"))


def create_installment(
    session: Session,
    *,
    order_id: int,
    contract_type: str,
    principal: Any = 0,
    down_payment: Any = 0,
    service_fee: Any = None,
    periods: int,
    per_period_service_fee: Any = 0,
    per_period: Any = 0,
    first_due_on: date,
    actor: str,
    delivery_mode: str | None = None,
    note: str | None = None,
    schedule: list[dict[str, Any]] | None = None,
    extra_values: Mapping[str, Any] | None = None,
    user: CurrentUser | None = None,
    adjust_final_period: bool = False,
) -> Installment:
    if first_due_on is None:
        raise Validation("首期应还日期必填", details={"field": "first_due_on"})

    try:
        InstallmentContractType(contract_type)
    except ValueError as exc:
        raise Validation(
            f"合约类型必须为 {InstallmentContractType.values()}",
            code=ErrorCode.INSTALLMENT_TYPE_INVALID,
            details={"contract_type": contract_type},
        ) from exc

    order = orders_service.get_order(session, order_id, user)
    if order.status != "ACTIVE":
        raise Conflict(
            f"订单 {order.order_no} 当前状态 {order.status}，不能创建分期合约",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"order_no": order.order_no, "status": order.status},
        )
    account = session.get(Account, order.account_id) if order.account_id is not None else None

    if contract_type == InstallmentContractType.STOCK_SALE.value:
        # HS 分期出售：账号必须已买入且在库。
        if order.order_type != "HS":
            raise Validation(
                "STOCK_SALE 只能用于 HS 订单",
                code=ErrorCode.INSTALLMENT_TYPE_INVALID,
                details={"order_no": order.order_no, "order_type": order.order_type},
            )
        # 售出订单本身不再重复 BUY；采购事实来自该库存账号的历史订单。
        has_buy_event = account is not None and session.scalar(
            select(OrderEvent.id)
            .join(Order, Order.id == OrderEvent.order_id)
            .where(
                Order.account_id == account.id,
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
        if order.account_id is not None and account is None:
            raise Validation(
                "ADVANCE_PURCHASE 关联的库存账号不存在",
                code=ErrorCode.INSTALLMENT_TYPE_INVALID,
                details={"order_no": order.order_no, "account_id": order.account_id},
            )
    elif contract_type == InstallmentContractType.PICKUP_SALE.value:
        if order.order_type != "TH":
            raise Validation(
                "PICKUP_SALE 只能用于 TH 订单",
                code=ErrorCode.INSTALLMENT_TYPE_INVALID,
                details={"order_no": order.order_no, "order_type": order.order_type},
            )
    elif contract_type == InstallmentContractType.CONSIGNMENT_SALE.value:
        if order.order_type != "DG":
            raise Validation(
                "CONSIGNMENT_SALE 只能用于 DG 订单",
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
    schedule_rates: dict[int, Decimal] = {}
    for item in _normalize_schedule(schedule):
        period_no = item["period_no"]
        if period_no < 1 or period_no > periods or period_no in schedule_dates:
            raise Validation("分期计划期次必须从 1 开始且不能重复", details={"period_no": period_no})
        schedule_dates[period_no] = item["due_on"]
        schedule_rates[period_no] = _non_negative(item.get("service_fee_rate", 0), field="service_fee_rate")

    if delivery_mode is not None:
        try:
            DeliveryMode(delivery_mode)
        except ValueError as exc:
            raise Validation(
                f"交付方式必须为 {DeliveryMode.values()}",
                code=ErrorCode.DELIVERY_CONDITION_UNMET,
                details={"delivery_mode": delivery_mode},
            ) from exc

    principal_amount = _non_negative(principal, field="principal")
    down_payment_amount = _non_negative(down_payment, field="down_payment")
    per_period_service_fee_amount = _non_negative(
        per_period_service_fee, field="per_period_service_fee"
    )
    # BAS-06-04：签约日固化分期规则（期数/首付/利率），改版不影响历史合约。
    # 提前到金额计算之前，服务费省略时才能按规则补算。
    order_type_definition = foundation_service.get_order_type_by_code(
        session, order.order_type
    )
    policy_version_id, policy_snapshot = policy_service.make_snapshot(
        session,
        policy_code=PolicyType.INSTALLMENT.value,
        on=first_due_on,
        scope_type="ORDER_TYPE",
        scope_id=order_type_definition.id if order_type_definition else None,
    )
    # 显式传值优先（含显式 0 = 不收服务费）；省略（None）才按规则费率补算。
    resolved_service_fee = service_fee
    if resolved_service_fee is None:
        resolved_service_fee = _service_fee_from_snapshot(
            session, policy_snapshot, order, principal_amount
        )
    service_fee_amount = _non_negative(resolved_service_fee, field="service_fee")
    per_period_amount = _non_negative(per_period, field="per_period")
    total_schedule_amount = down_payment_amount + per_period_amount * periods
    if down_payment_amount > principal_amount:
        raise Validation(
            "首付不能大于本金",
            details={
                "field": "down_payment",
                "down_payment": str(down_payment_amount),
                "principal": str(principal_amount),
            },
        )
    if principal_amount > total_schedule_amount:
        raise Validation(
            "本金不能大于首付与分期总额",
            details={
                "field": "principal",
                "principal": str(principal_amount),
                "maximum": str(total_schedule_amount),
            },
        )

    adjustment = principal_amount + service_fee_amount - total_schedule_amount if adjust_final_period else Decimal("0")
    if per_period_amount + adjustment < 0:
        raise Validation("每期金额过高，最后一期金额不能为负数", details={"field": "per_period"})

    installment = Installment(
        inst_no=order_installment_no(order.order_no),
        order_id=order.id,
        contract_type=contract_type,
        policy_version_id=policy_version_id,
        policy_snapshot=policy_snapshot,
        principal=principal_amount,
        down_payment=down_payment_amount,
        service_fee=service_fee_amount,
        periods=periods,
        per_period_service_fee=per_period_service_fee_amount,
        per_period=per_period_amount,
        final_period_adjustment=adjustment,
        paid_amount=Decimal("0"),
        waived_amount=Decimal("0"),
        bad_debt_amount=Decimal("0"),
        status=InstallmentStatus.PENDING.value,
        first_due_on=first_due_on,
        delivery_mode=delivery_mode,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(installment)
    session.flush()
    if contract_type == InstallmentContractType.STOCK_SALE.value:
        actor_id = session.scalar(select(User.id).where(User.username == actor))
        if actor_id is not None:
            for allocation in session.scalars(select(OrderProfitAllocation).where(OrderProfitAllocation.order_id == order.id, OrderProfitAllocation.allocation_type == "SELL")).all():
                allocation.user_id = actor_id
                allocation.updated_by = actor

    # 首付为期次 0，其后按期递增
    session.add(
        InstallmentSchedule(
            installment_id=installment.id,
            period_no=0,
            due_on=first_due_on,
            service_fee_rate=Decimal("0"),
            due_amount=down_payment_amount,
            received_amount=Decimal("0"),
            waived_amount=Decimal("0"),
            status=ScheduleStatus.PENDING.value,
        )
    )
    for index in range(1, periods + 1):
        session.add(
            InstallmentSchedule(
                installment_id=installment.id,
                period_no=index,
                due_on=schedule_dates.get(index, _add_months(first_due_on, index - 1)),
                service_fee_rate=schedule_rates.get(index, Decimal("0")),
                due_amount=per_period_amount + (adjustment if index == periods else Decimal("0")),
                received_amount=Decimal("0"),
                waived_amount=Decimal("0"),
                status=ScheduleStatus.PENDING.value,
            )
        )
    session.flush()
    parties_service.set_extra_values(
        session,
        entity_type="installment",
        entity_id=installment.id,
        values=(extra_values or {}).items(),
        require_all=True,
    )

    if account is not None:
        account.status = AccountStatus.INSTALLMENT.value
        account.updated_by = actor
    link_recovered_sale(
        session,
        order,
        occurred_on=order.trade_date,
        actor=actor,
        note=note,
    )

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


def list_installments(
    session: Session,
    *,
    status: str | None = None,
    order_id: int | None = None,
    user: CurrentUser | None = None,
) -> list[Installment]:
    stmt = select(Installment).join(Order, Order.id == Installment.order_id)
    if status:
        stmt = stmt.where(Installment.status == status)
    if order_id:
        stmt = stmt.where(Installment.order_id == order_id)
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
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
    user: CurrentUser | None = None,
) -> tuple[Installment, InstallmentSchedule]:
    """收款：`PAYMENT` 是收入事实，派生现金流并累计已收（DFQ-01-04/05）。"""
    installment = get_installment(session, installment_id, user)
    if installment.status in (
        InstallmentStatus.CANCELLED.value,
        InstallmentStatus.DELIVERED.value,
    ):
        raise Conflict(
            f"合约 {installment.inst_no} 状态 {installment.status}，不可收款",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"inst_no": installment.inst_no, "status": installment.status},
        )

    money = _positive(amount, field="amount")
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
    outstanding = (
        to_money(schedule.due_amount)
        - to_money(schedule.received_amount)
        - to_money(schedule.waived_amount)
    )
    if money > outstanding:
        raise Validation(
            f"第 {schedule.period_no} 期剩余应收 {outstanding}",
            code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE,
            details={"period_no": schedule.period_no, "outstanding": str(outstanding)},
        )

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
        user=user,
        allow_installment_payment=True,
    )

    schedule.received_amount = to_money(schedule.received_amount) + money
    schedule.received_on = paid_on
    schedule.status = (
        ScheduleStatus.PAID.value
        if schedule.received_amount + schedule.waived_amount >= schedule.due_amount
        else ScheduleStatus.PARTIAL.value
    )
    installment.paid_amount = to_money(installment.paid_amount) + money
    installment.updated_by = actor

    if installment.status == InstallmentStatus.PENDING.value:
        installment.status = transition(
            INSTALLMENT_TRANSITIONS, installment.status, "PAYMENT", entity="分期合约"
        )
    if to_money(installment.paid_amount) >= total_receivable(installment):
        if installment.status != InstallmentStatus.DEFAULTED.value:
            installment.status = transition(
                INSTALLMENT_TRANSITIONS,
                installment.status,
                "SETTLE",
                entity="分期合约",
            )
    session.flush()

    record_audit(
        session,
        action=AuditAction.INSTALLMENT_EARLY_SETTLE,
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


def cancel_installment(
    session: Session,
    installment_id: int,
    *,
    cancelled_on: date,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """终止交付前分期并登记原路退款。

    PAYMENT 逐笔用 CANCEL 冲销，沿用每笔收款的资金池。
    分期账号的回流/结束由合约类型决定：HS、DG 回库存，TH 直接失效。
    """
    text_reason = _required_text(reason, field="reason", message="取消分期必须填写原因")
    installment = get_installment(session, installment_id, user)
    cancellable = {
        InstallmentStatus.PENDING.value,
        InstallmentStatus.ACTIVE.value,
        InstallmentStatus.OVERDUE.value,
        InstallmentStatus.SETTLED.value,
    }
    if installment.status not in cancellable:
        raise Conflict(
            f"合约 {installment.inst_no} 状态 {installment.status}，不能取消交易",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"inst_no": installment.inst_no, "status": installment.status},
        )

    order = session.get(Order, installment.order_id)
    if order is None:
        raise NotFound("分期合约所属订单不存在", details={"order_id": installment.order_id})
    if order.status != "ACTIVE":
        raise Conflict(
            f"订单 {order.order_no} 当前状态 {order.status}，不能取消分期",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"order_no": order.order_no, "status": order.status},
        )

    event_ids: list[int] = []
    refund_amount = Decimal("0")
    reversed_amount = Decimal("0")
    original_events = session.scalars(
        select(OrderEvent)
        .where(
            OrderEvent.order_id == order.id,
            OrderEvent.event_type == EventType.PAYMENT.value,
            OrderEvent.is_posted.is_(True),
        )
        .order_by(OrderEvent.id)
    ).all()
    for original in original_events:
        cancelled = sum(
            (
                to_money(item.amount)
                for item in session.scalars(
                    select(OrderEvent).where(
                        OrderEvent.offset_event_id == original.id,
                        OrderEvent.event_type == EventType.CANCEL.value,
                        OrderEvent.is_posted.is_(True),
                    )
                ).all()
            ),
            Decimal("0"),
        )
        remaining = to_money(original.amount) - cancelled
        if remaining <= 0:
            continue
        reversal, _flow = orders_service.post_event(
            session,
            order.id,
            event_type=EventType.CANCEL.value,
            amount=remaining,
            occurred_on=cancelled_on,
            actor=actor,
            portion=original.portion,
            offset_event_id=original.id,
            reason=text_reason,
            note=f"取消交易原路退款：{installment.inst_no}",
            user=user,
            allow_installment_cancel=True,
            defer_order_cancel=True,
        )
        event_ids.append(reversal.id)
        refund_amount += remaining

    order.status = transition(ORDER_TRANSITIONS, order.status, "CANCEL", entity="订单")
    installment.status = transition(
        INSTALLMENT_TRANSITIONS, installment.status, "CANCEL", entity="分期合约"
    )
    account_status: str | None = None
    if order.account_id is not None:
        account = session.get(Account, order.account_id)
        if account is None:
            raise NotFound("分期合约关联账号不存在", details={"account_id": order.account_id})
        action = (
            "CANCEL_END"
            if installment.contract_type == InstallmentContractType.PICKUP_SALE.value
            else "CANCEL_STOCK"
        )
        account.status = transition(ACCOUNT_TRANSITIONS, account.status, action, entity="账号")
        account.updated_by = actor
        account_status = account.status
    installment.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.INSTALLMENT_CANCEL,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        after={
            "status": installment.status,
            "order_status": order.status,
            "account_status": account_status,
            "refund_amount": str(refund_amount),
            "reversed_amount": str(reversed_amount),
            "cancel_event_ids": event_ids,
        },
        reason=text_reason,
    )
    return {
        "installment": installment,
        "order_status": order.status,
        "account_status": account_status,
        "refund_amount": refund_amount,
        "reversed_amount": reversed_amount,
        "cancel_event_ids": event_ids,
    }


def waive_schedule(
    session: Session,
    installment_id: int,
    *,
    period_no: int,
    amount: Any,
    waived_on: date,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
) -> InstallmentSchedule:
    """登记经授权的期次减免，不改写原应收金额。"""
    text_reason = _required_text(reason, field="reason", message="减免必须填写原因")
    installment = get_installment(session, installment_id, user)
    schedule = session.scalar(
        select(InstallmentSchedule).where(
            InstallmentSchedule.installment_id == installment.id,
            InstallmentSchedule.period_no == period_no,
        )
    )
    if schedule is None:
        raise NotFound(f"期次 {period_no} 不存在", details={"period_no": period_no})
    if to_money(schedule.received_amount) > 0:
        raise Validation("已收期不可减免", details={"period_no": period_no})
    if schedule.status in {ScheduleStatus.PAID.value, ScheduleStatus.WAIVED.value}:
        raise Validation("已完成期次不可减免", details={"period_no": period_no})
    money = _positive(amount, field="amount")
    outstanding = to_money(schedule.due_amount) - to_money(schedule.waived_amount)
    if money > outstanding:
        raise Validation(
            "减免金额超过未收金额",
            code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE,
            details={"period_no": period_no, "outstanding": str(outstanding)},
        )
    before_waived = to_money(schedule.waived_amount)
    schedule.waived_amount = before_waived + money
    if to_money(schedule.received_amount) + to_money(schedule.waived_amount) >= to_money(
        schedule.due_amount
    ):
        schedule.status = ScheduleStatus.WAIVED.value
    installment.waived_amount = to_money(installment.waived_amount) + money
    if (
        installment.status
        in {
            InstallmentStatus.PENDING.value,
            InstallmentStatus.ACTIVE.value,
            InstallmentStatus.OVERDUE.value,
        }
        and to_money(installment.paid_amount) >= total_receivable(installment)
    ):
        installment.status = transition(
            INSTALLMENT_TRANSITIONS,
            installment.status,
            "SETTLE",
            entity="分期合约",
        )
    installment.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.INSTALLMENT_WAIVE,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        before={
            "period_no": period_no,
            "due_amount": str(schedule.due_amount),
            "waived_amount": str(before_waived),
        },
        after={
            "period_no": period_no,
            "due_amount": str(schedule.due_amount),
            "waived_amount": str(schedule.waived_amount),
            "status": schedule.status,
            "waived_on": waived_on.isoformat(),
        },
        reason=text_reason,
    )
    return schedule


def extend_schedule(
    session: Session,
    installment_id: int,
    *,
    period_no: int,
    new_due_on: date,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
) -> InstallmentSchedule:
    """修改未收期次到期日，并通过审计保留原计划日期。"""
    text_reason = _required_text(reason, field="reason", message="展期必须填写原因")
    installment = get_installment(session, installment_id, user)
    schedule = session.scalar(
        select(InstallmentSchedule).where(
            InstallmentSchedule.installment_id == installment.id,
            InstallmentSchedule.period_no == period_no,
        )
    )
    if schedule is None:
        raise NotFound(f"期次 {period_no} 不存在", details={"period_no": period_no})
    if to_money(schedule.received_amount) > 0:
        raise Validation("已收期不可展期", details={"period_no": period_no})
    if schedule.status in {ScheduleStatus.PAID.value, ScheduleStatus.WAIVED.value}:
        raise Validation("已完成期次不可展期", details={"period_no": period_no})
    if new_due_on <= schedule.due_on:
        raise Validation("展期后的到期日必须晚于原到期日", details={"field": "new_due_on"})
    original_due_on = schedule.due_on
    schedule.due_on = new_due_on
    if schedule.status == ScheduleStatus.OVERDUE.value:
        schedule.status = ScheduleStatus.PENDING.value
    installment.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.INSTALLMENT_EXTEND,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        before={"period_no": period_no, "due_on": original_due_on.isoformat()},
        after={"period_no": period_no, "due_on": new_due_on.isoformat()},
        reason=text_reason,
    )
    return schedule


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
            InstallmentSchedule.received_amount + InstallmentSchedule.waived_amount
            < InstallmentSchedule.due_amount,
        )
        .order_by(InstallmentSchedule.period_no)
    ).first()
    if schedule is None:
        raise Validation(
            "所有期次已收满", code=ErrorCode.PAYMENT_EXCEEDS_RECEIVABLE
        )
    return schedule


def settle_early(
    session: Session,
    installment_id: int,
    *,
    paid_on: date,
    actor: str,
    pool_id: int | None = None,
    note: str | None = None,
    user: CurrentUser | None = None,
) -> Installment:
    """提前收清剩余应收，逐期生成 PAYMENT 并关闭未来计划（DFQ-01-08）。"""
    installment = get_installment(session, installment_id, user)
    if installment.status in (
        InstallmentStatus.CANCELLED.value,
        InstallmentStatus.DELIVERED.value,
        InstallmentStatus.SETTLED.value,
    ):
        raise Conflict(
            f"合约 {installment.inst_no} 状态 {installment.status}，不可提前结清",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"inst_no": installment.inst_no, "status": installment.status},
        )
    rows = session.scalars(
        select(InstallmentSchedule)
        .where(
            InstallmentSchedule.installment_id == installment.id,
            InstallmentSchedule.received_amount + InstallmentSchedule.waived_amount
            < InstallmentSchedule.due_amount,
        )
        .order_by(InstallmentSchedule.period_no)
    ).all()
    if not rows:
        raise Validation("合约没有剩余应收，不能重复提前结清")
    for row in rows:
        outstanding = (
            to_money(row.due_amount)
            - to_money(row.received_amount)
            - to_money(row.waived_amount)
        )
        if outstanding <= 0:
            continue
        pay(
            session,
            installment.id,
            amount=outstanding,
            paid_on=paid_on,
            period_no=row.period_no,
            actor=actor,
            pool_id=pool_id,
            note=note or f"提前结清 {installment.inst_no} 第 {row.period_no} 期",
            user=user,
        )
    session.flush()
    record_audit(
        session,
        action=AuditAction.INSTALLMENT_PAYMENT,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        after={
            "action": "SETTLE_EARLY",
            "paid_total": str(to_money(installment.paid_amount)),
            "status": installment.status,
        },
    )
    return installment


def mark_default(
    session: Session,
    installment_id: int,
    *,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
) -> Installment:
    """将逾期合约置为违约，保留未收计划供后续追偿（DFQ-01-08）。"""
    text_reason = _required_text(
        reason, field="reason", message="违约处置必须填写原因"
    )
    installment = get_installment(session, installment_id, user)
    if installment.status != InstallmentStatus.OVERDUE.value:
        raise Validation(
            f"合约 {installment.inst_no} 当前不是逾期状态，不能登记违约",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"inst_no": installment.inst_no, "status": installment.status},
        )
    installment.status = transition(
        INSTALLMENT_TRANSITIONS,
        installment.status,
        "DEFAULT",
        entity="分期合约",
    )
    installment.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.INSTALLMENT_DEFAULT,
        entity_type="installment",
        entity_id=installment.inst_no,
        actor=actor,
        after={"status": installment.status},
        reason=text_reason,
    )
    return installment


def recover_account(
    session: Session,
    installment_id: int,
    *,
    occurred_on: date,
    actor: str,
    note: str,
    user: CurrentUser | None = None,
) -> InstallmentDisposition:
    """登记账号回收并关闭原分期，不改写原分期应收。"""
    text_note = _required_text(note, field="note", message="回收必须填写说明")
    installment = get_installment(session, installment_id, user)
    if installment.status not in {
        InstallmentStatus.OVERDUE.value,
        InstallmentStatus.DEFAULTED.value,
    }:
        raise Validation("只有逾期或违约合约可以回收账号")
    order = session.get(Order, installment.order_id)
    if order is None:
        raise Validation("分期合约没有所属订单")
    if order.account_id is None and order.order_type == "DFQ":
        _materialize_dfq_recovery_account(session, order, actor=actor)
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
    return disposition


def record_sale(
    session: Session,
    installment_id: int,
    *,
    sale_order_id: int,
    occurred_on: date,
    actor: str,
    note: str,
    user: CurrentUser | None = None,
) -> InstallmentDisposition:
    """登记回收账号的出售订单，并保留原分期与出售订单的利润关联。"""
    text_note = _required_text(note, field="note", message="出售必须填写说明")
    installment = get_installment(session, installment_id, user)
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
    return disposition


def record_resale(
    session: Session,
    installment_id: int,
    *,
    resale_order_id: int,
    occurred_on: date,
    actor: str,
    note: str,
    user: CurrentUser | None = None,
) -> InstallmentDisposition:
    """兼容旧调用；新流程统一使用 record_sale。"""
    return record_sale(
        session,
        installment_id,
        sale_order_id=resale_order_id,
        occurred_on=occurred_on,
        actor=actor,
        note=note,
        user=user,
    )


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
    actor: str,
    user: CurrentUser | None = None,
) -> Installment:
    """换绑交付：只能从 `SETTLED` 进入，生成无金额 `DELIVER`（DFQ-01-07 / A04 / A05）。"""
    installment = get_installment(session, installment_id, user)
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
    return installment


def mark_overdue(
    session: Session,
    *,
    as_of: date,
    actor: str = "system",
    user: CurrentUser | None = None,
) -> int:
    """按到期日实时标记逾期；已收满的期次不标记（DFQ-01-06）。"""
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
    count = 0
    for row in rows:
        row.status = ScheduleStatus.OVERDUE.value
        count += 1
    if rows:
        installment_ids = {row.installment_id for row in rows}
        for installment_id in installment_ids:
            installment = session.get(Installment, installment_id)
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
                        "overdue_periods": sum(
                            1
                            for row in rows
                            if row.installment_id == installment.id
                        ),
                    },
                )
    session.flush()
    return count


__all__ = [
    "cancel_installment",
    "create_installment",
    "deliver",
    "extend_schedule",
    "get_installment",
    "list_installments",
    "mark_default",
    "mark_overdue",
    "pay",
    "settle_early",
    "total_receivable",
    "waive_schedule",
]
