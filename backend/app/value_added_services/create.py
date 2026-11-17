"""value_added_services.create：分期合约建档、回收出售关联与合约列表（BAS-03）。

建档只落合约与期次计划，金额与状态后续由还款/交付动作推进。
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
from typing import Any
from pydantic import ValidationError as PydanticValidationError
from app.shared.audit import record_audit
from app.shared.business_numbering import installment_no as order_installment_no
from app.core.security import CurrentUser
from app.domain.users import User
from app.foundation.order_types import get_order_type_by_code
from app.value_added_services.schemas import ScheduleCreate
from app.shared.order_access import get_order
from app.shared.order_amounts import order_amounts
from app.shared.form_values import set_extra_values
from app.policy import versions as policy_versions
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import (
    Conflict,
    ErrorCode,
    Validation,
)
from app.core.money import to_money
from app.shared.operation_operators import upsert_operation_operators
from app.core.state_machine import (
    ACCOUNT_TRANSITIONS,
    ORDER_TRANSITIONS,
    transition,
)
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
from ._shared import (
    _add_months,
    _non_negative,
    total_receivable,
)


def sale_installment_plan(
    *,
    sale_amount: Any,
    down_payment: Any = 0,
    service_fee: Any = 0,
    periods: int,
    per_period: Any = None,
) -> dict[str, Any]:
    """Calculate the stock-sale installment plan using Decimal money values."""
    sale = _non_negative(sale_amount, field="sale_amount")
    down = _non_negative(down_payment, field="down_payment")
    fee = _non_negative(service_fee, field="service_fee")
    if periods <= 0:
        raise Validation("期数必须大于 0", details={"field": "periods", "value": periods})
    if down > sale:
        raise Validation("首付不能超过售出金额", details={"field": "down_payment"})
    base = sale - down
    total = base + fee
    suggested = (total / Decimal(periods)).quantize(Decimal("0.01"), rounding=ROUND_CEILING)
    supplied = None if per_period is None else _non_negative(per_period, field="per_period")
    effective = suggested if supplied is None else supplied
    last = total - effective * (periods - 1)
    return {
        "principal": sale,
        "down_payment": down,
        "service_fee": fee,
        "periods": periods,
        "base_amount": base,
        "total_schedule_amount": total,
        "per_period": suggested,
        "last_period": last,
        "per_period_service_fee": (fee / Decimal(periods)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP),
        "per_period_matches": None if supplied is None else (
            supplied * periods >= base and supplied * (periods - 1) <= total
        ),
    }


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
    if not candidates:
        return None
    # 一次性取「已转售过」的合约集合，避免在 candidates 上逐条 EXISTS（N+1）。
    resold_installment_ids = set(
        session.scalars(
            select(InstallmentDisposition.installment_id).where(
                InstallmentDisposition.action == InstallmentDispositionAction.RESELL.value,
                InstallmentDisposition.installment_id.in_(
                    {candidate.installment_id for candidate in candidates}
                ),
            )
        ).all()
    )
    recovered = next(
        (
            candidate
            for candidate in candidates
            if candidate.installment_id not in resold_installment_ids
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


#: 合约类型 → 允许的订单类型；未登记的类型不做该约束由调用方另行校验。
#: 分期出售的业务名称只有一个，回收/提号售出可用，代挂售出仅全款不建分期合约；
#: PICKUP_SALE / CONSIGNMENT_SALE 是迁移 0056 之前的遗留类型，只为读取历史数据保留。
_CONTRACT_ALLOWED_ORDER_TYPES = {
    InstallmentContractType.STOCK_SALE.value: frozenset({"HS", "TH"}),
    InstallmentContractType.PICKUP_SALE.value: frozenset({"TH"}),
    InstallmentContractType.CONSIGNMENT_SALE.value: frozenset(),
}


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
    operator_user_ids: list[int] | None = None,
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

    order = get_order(session, order_id, user)
    existing = session.scalar(
        select(Installment).where(Installment.order_id == order.id)
    )
    if existing is not None:
        raise Conflict(
            f"订单 {order.order_no} 已存在分期合约 {existing.inst_no}",
            code=ErrorCode.INSTALLMENT_TYPE_INVALID,
            details={"inst_no": existing.inst_no},
        )
    if order.status != "ACTIVE":
        raise Conflict(
            f"订单 {order.order_no} 当前状态 {order.status}，不能创建分期合约",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"order_no": order.order_no, "status": order.status},
        )
    account = session.get(Account, order.account_id) if order.account_id is not None else None

    # 合约类型 → 允许的订单类型。四个分支原本结构完全相同、只差这一个值，
    # 表驱动比复制四遍 if/elif 更难漏改、也更好审计（新增类型必须在此登记或显式例外）。
    allowed_order_types = _CONTRACT_ALLOWED_ORDER_TYPES.get(contract_type)
    if allowed_order_types is not None and order.order_type not in allowed_order_types:
        if not allowed_order_types:
            # 空集 = 该合约类型已不再对任何订单开放（代挂售出仅全款）。
            raise Validation(
                "代挂售出仅全款，不提供分期出售",
                code=ErrorCode.INSTALLMENT_TYPE_INVALID,
                details={"order_no": order.order_no, "contract_type": contract_type},
            )
        allowed_order_label = "、".join(sorted(allowed_order_types))
        raise Validation(
            f"{contract_type} 只能用于 {allowed_order_label} 订单",
            code=ErrorCode.INSTALLMENT_TYPE_INVALID,
            details={"order_no": order.order_no, "order_type": order.order_type},
        )

    if contract_type == InstallmentContractType.STOCK_SALE.value:
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
        installment_sell_events = (
            session.scalars(
                select(OrderEvent).where(
                    OrderEvent.order_id == order.id,
                    OrderEvent.event_type == EventType.SELL.value,
                    OrderEvent.is_posted.is_(True),
                )
            ).all()
            if account is not None
            else []
        )
        has_installment_sell = any(
            (event.form_extra or {}).get("sale_mode") == "INSTALLMENT"
            for event in installment_sell_events
        )
        # DG 代挂订单创建即把账号纳入库存，没有 BUY 事件；HS/TH 仍要求可追溯买入流水。
        requires_buy_event = account is not None and account.inventory_type != "CONSIGNMENT"
        account_is_ready = account is not None and (
            account.status == AccountStatus.WAITING.value
            or (account.status == AccountStatus.SOLD.value and has_installment_sell)
        )
        if not account_is_ready or (requires_buy_event and not has_buy_event):
            raise Validation(
                "STOCK_SALE 要求账号已入库且已在库",
                code=ErrorCode.INSTALLMENT_TYPE_INVALID,
                details={"account_status": account.status if account else None},
            )
    # PICKUP_SALE → TH、CONSIGNMENT_SALE → DG 的订单类型校验已在上方表驱动分支统一处理。

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
    order_type_definition = get_order_type_by_code(
        session, order.order_type
    )
    policy_version_id, policy_snapshot = policy_versions.make_snapshot(
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

    # 分期合约号统一由业务订单号派生；一笔订单只允许一条分期合约。
    installment_no_value = order_installment_no(order.order_no)
    installment = Installment(
        inst_no=installment_no_value,
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
    set_extra_values(
        session,
        entity_type="installment",
        entity_id=installment.id,
        values=(extra_values or {}).items(),
        require_all=True,
    )

    if account is not None and account.status == AccountStatus.WAITING.value:
        # 分期状态归 installments.status；账号一旦签约即视为已售，库存归属由
        # stock.inventory_status 独立标记为出库。
        account.status = transition(
            ACCOUNT_TRANSITIONS, account.status, "SELL", entity="账号"
        )
        account.updated_by = actor
    order.status = transition(
        ORDER_TRANSITIONS, order.status, "INSTALLMENT", entity="订单"
    )
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
    upsert_operation_operators(
        session,
        entity_type="installment",
        entity_id=installment.inst_no,
        operation_key="CREATE",
        actor=actor,
        operator_user_ids=operator_user_ids,
        occurred_at=installment.created_at,
    )
    return installment


# P0-A（2026-11-18）：非分期 SELL 完成后的回收处置联动经协作注册点注入，
# 消灭 orders -> value_added_services 反向依赖（backend/.importlinter 契约）。
# 本模块由 api_v1 -> installments_router -> value_added_services.router 链路必然加载。
from app.orders.collaboration import register_post_sell_hook

register_post_sell_hook(link_recovered_sale)
