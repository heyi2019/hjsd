"""orders 事件登记服务（ORD-02）。"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any

from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.shared.business_numbering import event_no as next_event_no
from app.core.errors import Validation
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
)
from app.domain.trade import Cashflow, OrderEvent
from ._common import _non_negative_money, _positive_money
from .cancellation_model import opposite_cancellation_direction as _opposite_direction
from .events_helpers import (
    _assert_event_context,
    _auto_link_recovered_installment_sale,
    _build_event_form_extra,
    _normalize_event_input,
    _resolve_event_funding_context,
)
from .events_rules import (
    _apply_account_effect,
    _assert_event_allowed,
    _assert_sellable_order,
    _post_deliver,
)

# 事件 → 现金流方向 / 性质 / 分类
EVENT_FLOW_MAP: dict[str, tuple[str, str, str]] = {
    EventType.BUY.value: (Direction.OUT.value, Nature.BUSINESS_OUT.value, "BUY"),
    EventType.SELL.value: (Direction.IN.value, Nature.BUSINESS_IN.value, "SELL"),
    EventType.CANCEL.value: (Direction.IN.value, Nature.BUSINESS_IN.value, "CANCEL"),
}


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
    source_type: str | None = None,
    source_id: str | None = None,
    user: CurrentUser | None = None,
    allow_installment_delivery: bool = False,
) -> tuple[OrderEvent, Cashflow | None]:
    """登记：状态校验 → 池路由 → 事件落库 → 现金流派生 → 账号/订单状态，同一事务。

    ``source_type``/``source_id`` 是可选的显式业务来源配对（如返点事件回指
    RebateRecord）；不传时事件无来源，行为与改造前一致。
    """
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
    (
        offset,
        cancel_fully_consumed,
        accounting_attribute,
        resolved_pool_id,
        cancel_direction,
    ) = _resolve_event_funding_context(
        session,
        order,
        event_type=event_type,
        offset_event_id=offset_event_id,
        pool_id=pool_id,
        money=money,
        has_cashflow=has_cashflow,
        portion=portion,
        user=user,
    )

    event_form_extra = _build_event_form_extra(
        session,
        order,
        event_type=event_type,
        sale_mode=sale_mode,
        operation_type=operation_type,
        rebate_type=rebate_type,
        bound_phone=bound_phone,
        bound_phone_owner=bound_phone_owner,
        form_extra=form_extra,
        form_extra_scope=form_extra_scope,
        actor=actor,
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
        source_type=source_type,
        source_id=source_id,
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


__all__ = [
    "_apply_account_effect",
    "_opposite_direction",
    "post_event",
]
