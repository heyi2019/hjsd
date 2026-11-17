"""orders 事件登记服务（ORD-02）。"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.shared.business_numbering import event_no as next_event_no
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.shared.numbering import allocate_flow_no
from app.core.security import CurrentUser
from app.core.time import now_second
from app.core.state_machine import ORDER_TRANSITIONS, transition
from app.domain.enums import (
    AuditAction,
    CashflowSourceType,
    Direction,
    EventType,
    Nature,
    OperationType,
    OrderStatus,
    Portion,
    RebateType,
    SaleMode,
)
from app.domain.trade import Account, Cashflow, Installment, Order, OrderEvent
from app.domain.users import User
from app.domain.cashflow_attributes import accounting_attribute_for_order_event
from app.shared.form_field_rules import validate_form_extra
from ._common import (
    _non_negative_money,
    _positive_money,
    _required_bool,
)

# 事件 → 现金流方向 / 性质 / 分类
EVENT_FLOW_MAP: dict[str, tuple[str, str, str]] = {
    EventType.BUY.value: (Direction.OUT.value, Nature.BUSINESS_OUT.value, "BUY"),
    EventType.SELL.value: (Direction.IN.value, Nature.BUSINESS_IN.value, "SELL"),
    EventType.CANCEL.value: (Direction.IN.value, Nature.BUSINESS_IN.value, "CANCEL"),
}


def _auto_link_recovered_installment_sale(
    session: Session,
    order: Order,
    *,
    occurred_on: date,
    actor: str,
    note: str | None,
) -> None:
    """库存中心完成出售后，自动关联该账号最近一次未转售的回收处置。

    实际联动逻辑由 value_added_services 域经 collaboration 注册点注入
    （orders 不得反向依赖 vas，见 backend/.importlinter）。
    """
    from .collaboration import run_post_sell_hooks

    run_post_sell_hooks(
        session,
        order,
        occurred_on=occurred_on,
        actor=actor,
        note=note,
    )

# --------------------------------------------------------------------- 事件
def _assert_event_context(
    session: Session,
    order: Order,
    *,
    event_type: str,
    operator_user_ids: list[int] | None,
    pool_id: int | None,
    user: CurrentUser | None,
) -> bool:
    """操作人/资金池可见性与订单状态守卫：只读校验，判定口径与原内联版本一致。

    返回 can_reopen_for_buy 供后续「已完成订单重开 BUY」分支复用。
    """
    if operator_user_ids is not None:
        if len(set(operator_user_ids)) != len(operator_user_ids):
            raise Validation("操作人不能重复选择", details={"field": "operator_user_ids"})
        active_ids = set(
            session.scalars(
                select(User.id).where(User.id.in_(operator_user_ids), User.is_active.is_(True))
            ).all()
        )
        if active_ids != set(operator_user_ids):
            raise Validation("所选操作人不存在或已停用", details={"field": "operator_user_ids"})
    if pool_id is not None and user is not None and not user.can_see_pool(pool_id):
        raise NotFound("资金账户不存在", details={"pool_id": pool_id})
    can_cancel_completed = (
        event_type == EventType.CANCEL.value
        and order.status == OrderStatus.COMPLETED.value
    )
    can_reopen_for_buy = (
        event_type == EventType.BUY.value
        and order.status == OrderStatus.COMPLETED.value
        and order.order_type in {"HS", "TH"}
        and session.scalar(
            select(Installment.id).where(Installment.order_id == order.id)
        )
        is None
    )
    can_validate_completed_sell = (
        event_type == EventType.SELL.value
        and order.status == OrderStatus.COMPLETED.value
        and session.scalar(
            select(Installment.id).where(Installment.order_id == order.id)
        )
        is None
    )
    can_register_delivery = (
        event_type == EventType.DELIVER.value
        and order.status != OrderStatus.CANCELLED.value
    )
    can_register_action = (
        event_type in {
            EventType.OPERATE.value,
            EventType.REBATE.value,
        }
        and order.status != OrderStatus.CANCELLED.value
    )
    if order.status not in {OrderStatus.ACTIVE.value, OrderStatus.INSTALLMENT.value} and not (
        can_cancel_completed
        or can_reopen_for_buy
        or can_validate_completed_sell
        or can_register_delivery
        or can_register_action
    ):
        raise Conflict(
            f"订单 {order.order_no} 当前状态 {order.status}，不能登记事件",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"order_no": order.order_no, "current_status": order.status},
        )
    return can_reopen_for_buy


def _normalize_event_input(
    *,
    event_type: str,
    sale_mode: str | None,
    operation_type: str | None,
    rebate_type: str | None,
    portion: str,
    allow_installment_delivery: bool,
) -> tuple[str | None, str | None, str | None, bool, str, bool]:
    """事件入参校验与规范化：执行顺序与异常口径与原内联版本完全一致。"""
    allow_installment_delivery = _required_bool(
        allow_installment_delivery, field="allow_installment_delivery"
    )
    try:
        EventType(event_type)
    except ValueError as exc:
        raise Validation(
            f"事件类型必须为 {EventType.values()}",
            details={"field": "event_type", "value": event_type},
        ) from exc
    if event_type == EventType.SELL.value:
        sale_mode = (sale_mode or SaleMode.FULL.value).strip().upper()
        try:
            sale_mode = SaleMode(sale_mode).value
        except ValueError as exc:
            raise Validation(
                f"sale_mode 必须为 {SaleMode.values()}",
                details={"field": "sale_mode", "value": sale_mode},
            ) from exc
    elif sale_mode is not None:
        raise Validation(
            "只有 SELL 事件可以填写 sale_mode",
            details={"field": "sale_mode", "event_type": event_type},
        )
    action_attributes = {
        EventType.OPERATE.value: ("operation_type", operation_type, OperationType),
        EventType.REBATE.value: ("rebate_type", rebate_type, RebateType),
    }
    action_attribute = action_attributes.get(event_type)
    if action_attribute is not None:
        field, value, enum_type = action_attribute
        if value is None or not isinstance(value, str) or not value.strip():
            raise Validation(
                f"{event_type} 必须填写 {field}",
                details={"field": field, "event_type": event_type},
            )
        try:
            normalized = enum_type(value.strip().upper()).value
        except ValueError as exc:
            raise Validation(
                f"{field} 必须为 {enum_type.values()}",
                details={"field": field, "value": value},
            ) from exc
        if field == "operation_type":
            operation_type = normalized
        elif field == "rebate_type":
            rebate_type = normalized
    elif any(value is not None for value in (operation_type, rebate_type)):
        raise Validation(
            "运营、返点属性只能用于对应的 OPERATE、REBATE 事件",
            details={"event_type": event_type},
        )
    installment_sale = (
        event_type == EventType.SELL.value
        and sale_mode == SaleMode.INSTALLMENT.value
    )
    try:
        portion = Portion(portion).value
    except ValueError as exc:
        raise Validation(
            f"portion 必须为 {Portion.values()}",
            details={"field": "portion", "value": portion},
        ) from exc
    return (
        sale_mode, operation_type, rebate_type, installment_sale, portion,
        allow_installment_delivery,
    )


def post_event(
    session: Session,
    order_id: int,
    *,
    event_type: str,
    sale_mode: str | None = None,
    operation_type: str | None = None,
    rebate_type: str | None = None,
    amount: Any = 0,
    occurred_on: date,
    actor: str,
    pool_id: int | None = None,
    portion: str = "PRINCIPAL",
    delivery_mode: str | None = None,
    delivery_direction: str | None = None,
    offset_event_id: int | None = None,
    reason: str | None = None,
    operator_user_ids: list[int] | None = None,
    note: str | None = None,
    bound_phone: str | None = None,
    bound_phone_owner: str | None = None,
    form_extra: Mapping[str, Any] | None = None,
    form_extra_scope: str | None = None,
    user: CurrentUser | None = None,
    allow_installment_delivery: bool = False,
) -> tuple[OrderEvent, Cashflow | None]:
    """登记：状态校验 → 池路由 → 事件落库 → 现金流派生 → 账号/订单状态，同一事务。"""
    from app.shared.order_access import get_order

    (
        sale_mode,
        operation_type,
        rebate_type,
        installment_sale,
        portion,
        allow_installment_delivery,
    ) = _normalize_event_input(
        event_type=event_type,
        sale_mode=sale_mode,
        operation_type=operation_type,
        rebate_type=rebate_type,
        portion=portion,
        allow_installment_delivery=allow_installment_delivery,
    )

    order = get_order(session, order_id, user)
    can_reopen_for_buy = _assert_event_context(
        session,
        order,
        event_type=event_type,
        operator_user_ids=operator_user_ids,
        pool_id=pool_id,
        user=user,
    )

    _assert_event_allowed(
        session,
        order,
        event_type,
        offset_event_id=offset_event_id,
        reason=reason,
    )

    if event_type == EventType.DELIVER.value:
        return _post_deliver(
            session,
            order,
            occurred_on=occurred_on,
            actor=actor,
            delivery_mode=delivery_mode,
            delivery_direction=delivery_direction,
            note=note,
            bound_phone=bound_phone,
            bound_phone_owner=bound_phone_owner,
            form_extra=form_extra,
            allow_installment_delivery=allow_installment_delivery,
        )

    if event_type == EventType.SELL.value:
        _assert_sellable_order(session, order)

    has_cashflow = event_type in EVENT_FLOW_MAP and not installment_sale
    if not has_cashflow and event_type != EventType.DELIVER.value:
        if pool_id is not None:
            raise Validation(
                f"{event_type} 业务动作不直接选择资金账户",
                details={"field": "pool_id", "event_type": event_type},
            )
    direction, nature, category = EVENT_FLOW_MAP.get(event_type, (None, None, None))
    # 初始买入(BUY)对应的号价/成本允许为 0：提号表单将该字段设为选填时前端以 0 兜底，
    # 此处需放行 0；其余资金事件金额必须为正数，以保持账务完整。
    if not has_cashflow:
        money = _non_negative_money(amount, field="amount")
    elif event_type == EventType.BUY.value:
        money = _non_negative_money(amount, field="amount")
    else:
        money = _positive_money(amount, field="amount")
    if installment_sale and pool_id is not None:
        raise Validation(
            "分期售出只登记 SELL 业务事实，资金账户与金额应在分期收款时填写",
            details={"field": "pool_id"},
        )
    offset = None
    cancel_fully_consumed = False
    if event_type == EventType.CANCEL.value and offset_event_id is not None:
        offset = _get_offset_event(session, offset_event_id, order_id=order.id)
        if pool_id is not None and pool_id != offset.pool_id:
            raise Validation(
                "冲销必须沿用被冲销事件的资金账户",
                details={
                    "offset_event_id": offset_event_id,
                    "offset_pool_id": offset.pool_id,
                    "pool_id": pool_id,
                },
            )
        already_cancelled = session.scalar(
            select(func.coalesce(func.sum(OrderEvent.amount), 0)).where(
                OrderEvent.offset_event_id == offset.id,
                OrderEvent.event_type == EventType.CANCEL.value,
                OrderEvent.is_posted.is_(True),
            )
        ) or 0
        remaining = to_money(offset.amount) - to_money(already_cancelled)
        if money > remaining:
            raise Validation(
                f"超过被冲销事件剩余可冲销金额 {remaining}",
                details={
                    "offset_event_id": offset_event_id,
                    "remaining": str(remaining),
                    "amount": str(money),
                },
            )
        cancel_fully_consumed = money >= remaining
    accounting_attribute: str | None = None
    resolved_pool_id: int | None = None
    if has_cashflow:
        accounting_attribute = accounting_attribute_for_order_event(
            order.order_type, event_type
        )
        resolved_pool_id = (
            pool_id
            or (offset.pool_id if offset is not None else None)
            or _resolve_pool(session, order, portion).id
        )
        if user is not None and not user.can_see_pool(resolved_pool_id):
            raise NotFound("资金账户不存在", details={"pool_id": resolved_pool_id})
        _assert_pool_active(session, resolved_pool_id)
    cancel_direction = Direction.IN.value
    if event_type == EventType.CANCEL.value:
        cancel_direction = _opposite_direction(offset_event_id, session, order_id=order.id)

    normalized_bound_phone = bound_phone.strip() if isinstance(bound_phone, str) and bound_phone.strip() else None
    normalized_bound_phone_owner = bound_phone_owner.strip() if isinstance(bound_phone_owner, str) and bound_phone_owner.strip() else None
    event_form_extra = validate_form_extra(
        session, order_type_code=(form_extra_scope or "REFUND"), values=form_extra
    )
    if event_type == EventType.SELL.value and sale_mode is not None:
        event_form_extra["sale_mode"] = sale_mode
    if operation_type is not None:
        event_form_extra["operation_type"] = operation_type
    if rebate_type is not None:
        event_form_extra["rebate_type"] = rebate_type
    if event_type == EventType.SELL.value and (normalized_bound_phone is not None or normalized_bound_phone_owner is not None):
        account = session.get(Account, order.account_id) if order.account_id is not None else None
        snapshot = dict(order.account_snapshot or {})
        if normalized_bound_phone is not None:
            snapshot["bound_phone"] = normalized_bound_phone
        if normalized_bound_phone_owner is not None:
            snapshot["bound_phone_owner"] = normalized_bound_phone_owner
        order.account_snapshot = snapshot or None
        if account is not None and normalized_bound_phone is not None:
            account.bound_phone = normalized_bound_phone
            account.updated_by = actor
        event_form_extra.update(
            {"bound_phone": normalized_bound_phone} if normalized_bound_phone is not None else {}
        )
        event_form_extra.update(
            {"bound_phone_owner": normalized_bound_phone_owner} if normalized_bound_phone_owner is not None else {}
        )

    event = OrderEvent(
        event_no=next_event_no(
            session, order_no=order.order_no, order_id=order.id, event_type=event_type
        ),
        order_id=order.id,
        event_type=event_type,
        amount=money,
        portion=portion,
        occurred_on=occurred_on,
        pool_id=resolved_pool_id,
        offset_event_id=offset_event_id,
        reason=reason,
        operator_user_ids=operator_user_ids,
        note=note,
        form_extra=event_form_extra or None,
        is_posted=True,
        posted_at=now_second(),
        created_by=actor,
        updated_by=actor,
    )
    session.add(event)
    session.flush()

    if event_type == EventType.CANCEL.value:
        direction = cancel_direction
        # nature 必须随反转后的 direction 走，否则会产出 OUT/BUSINESS_IN（或
        # IN/BUSINESS_OUT）这种自相矛盾的流水：余额按方向变了，但资金账户收支卡片
        # 与资金日报发生额列按 (direction, nature) 取数，两边都不体现，账对不上。
        # 与 finance/cashflows.py::reverse_cashflow 的反向约定保持一致。
        nature = (
            Nature.BUSINESS_IN.value
            if direction == Direction.IN.value
            else Nature.BUSINESS_OUT.value
        )

    flow: Cashflow | None = None
    if has_cashflow:
        flow = Cashflow(
            flow_no=allocate_flow_no(session, direction),
            pool_id=event.pool_id,
            occurred_on=occurred_on,
            nature=nature,
            accounting_attribute=accounting_attribute,
            category=category,
            direction=direction,
            amount=money,
            source_type=CashflowSourceType.ORDER_EVENT.value,
            source_id=event.event_no,
            order_id=order.id,
            operator_user_ids=operator_user_ids,
            note=note,
            created_by=actor,
            updated_by=actor,
        )
        session.add(flow)

    if event_type in {
        EventType.BUY.value,
        EventType.SELL.value,
        EventType.CANCEL.value,
    }:
        _apply_account_effect(
            session,
            order,
            event_type,
            money,
            offset_event=offset,
            cancel_fully_consumed=(offset is None or cancel_fully_consumed),
            actor=actor,
        )
    if event_type == EventType.SELL.value and not installment_sale:
        # 非分期订单以 SELL 作为终态事件；分期订单不会进入此分支，
        # 它们必须通过分期合同收款并在结清后 DELIVER 完成闭环。
        order.status = transition(
            ORDER_TRANSITIONS, order.status, "COMPLETE", entity="订单"
        )
        _auto_link_recovered_installment_sale(
            session,
            order,
            occurred_on=occurred_on,
            actor=actor,
            note=note,
        )
    elif event_type == EventType.BUY.value and can_reopen_for_buy:
        # 同一库存账号允许再次买入，重新开启该订单的业务周期。
        order.status = transition(
            ORDER_TRANSITIONS, order.status, "BUY", entity="订单"
        )
    if event_type == EventType.CANCEL.value and (
        (offset is None or cancel_fully_consumed)
    ):
        # 冲销事件闭环：订单进入 CANCELLED，此后不再接受任何新事件
        order.status = transition(
            ORDER_TRANSITIONS, order.status, "CANCEL", entity="订单"
        )
    session.flush()

    # 售出完成后提醒本次 SELL 执行人配置分润；通知通过
    # recipient+type+entity 幂等去重，重复售出不重复打扰。
    if event_type == EventType.SELL.value and not installment_sale:
        from app.notifications.triggers import notify_seller_to_allocate

        notify_seller_to_allocate(session, order, event, actor=actor)

    record_audit(
        session,
        action=AuditAction.EVENT_POST,
        entity_type="order_event",
        entity_id=event.event_no,
        actor=actor,
        after={
            "order_no": order.order_no,
            "event_type": event_type,
            "amount": str(money),
            "pool_id": event.pool_id,
            "flow_no": flow.flow_no if flow is not None else None,
        },
        reason=reason,
    )
    return event, flow

from .cancellation_model import (
    get_cancellation_offset as _get_offset_event,
    opposite_cancellation_direction as _opposite_direction,
)
from .events_rules import (
    _apply_account_effect,
    _assert_event_allowed,
    _assert_pool_active,
    _assert_sellable_order,
    _post_deliver,
    _resolve_pool,
)

__all__ = [
    "_apply_account_effect",
    "_opposite_direction",
    "post_event",
]
