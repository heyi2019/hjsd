"""取消模型。

取消分为两类：
- 无已登记资金事件，或仅有 DG 寄售运营事件：直接将订单置为已取消；
- 有已登记资金事件：以 ``CANCEL`` 反向冲销原事件，并派生反向资金流水。

本模块集中保存取消的校验、资金方向和账号状态规则，避免散落在订单编辑、
事件登记与分期流程中而出现同一业务口径不一致。
"""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.money import to_money
from app.core.security import CurrentUser
from app.core.state_machine import ACCOUNT_TRANSITIONS, ORDER_TRANSITIONS, transition
from app.domain.enums import (
    AccountStatus,
    AuditAction,
    Direction,
    EventType,
)
from app.domain.trade import Account, Order, OrderEvent
from app.shared.form_field_rules import validate_form_extra

from .validation import _required_text
from app.shared.order_access import get_order


_CANCELLABLE_EVENT_TYPES = frozenset({
    EventType.BUY.value,
    EventType.SELL.value,
})


def _is_consignment_operation(event: OrderEvent) -> bool:
    return (
        event.event_type == EventType.OPERATE.value
        and (event.form_extra or {}).get("operation_type") in {"CONSIGNMENT", "UNLIST"}
    )


def _can_cancel_after_consignment(order: Order, events: list[OrderEvent]) -> bool:
    """系统下架允许 DG 在寄售/下架运营事件后完成普通取消。"""
    return order.order_type == "DG" and bool(events) and all(
        _is_consignment_operation(event) for event in events
    )


def cancellation_direction_for_offset_type(event_type: str) -> str:
    """返回冲销原资金事件后应产生的现金流方向。"""
    if event_type == EventType.BUY.value:
        return Direction.IN.value
    return Direction.OUT.value


def get_cancellation_offset(
    session: Session, offset_event_id: int, *, order_id: int | None = None
) -> OrderEvent:
    """读取并校验可冲销的已过账资金事件。"""
    offset = session.get(OrderEvent, offset_event_id)
    if offset is None:
        raise NotFound(
            f"被冲销事件 {offset_event_id} 不存在",
            details={"offset_event_id": offset_event_id},
        )
    if order_id is not None and offset.order_id != order_id:
        raise Validation(
            "冲销事件必须属于同一订单",
            details={
                "order_id": order_id,
                "offset_event_id": offset_event_id,
                "offset_order_id": offset.order_id,
            },
        )
    if not offset.is_posted:
        raise Validation(
            "只能冲销已登记事件",
            details={"offset_event_id": offset_event_id},
        )
    if offset.event_type not in _CANCELLABLE_EVENT_TYPES:
        raise Validation(
            "只能冲销有金额的业务事件",
            details={"offset_event_id": offset_event_id, "event_type": offset.event_type},
        )
    return offset


def opposite_cancellation_direction(
    offset_event_id: int | None,
    session: Session,
    *,
    order_id: int | None = None,
) -> str:
    """按原事件取得取消流水的反向资金方向。"""
    if offset_event_id is None:
        return Direction.IN.value
    offset = get_cancellation_offset(session, offset_event_id, order_id=order_id)
    return cancellation_direction_for_offset_type(offset.event_type)


def apply_cancellation_account_effect(
    account: Account,
    amount: Decimal,
    *,
    offset_event: OrderEvent | None,
    cancel_fully_consumed: bool,
    actor: str | None,
) -> None:
    """把一次取消映射到账号成本与库存状态。"""
    if offset_event is not None and offset_event.event_type == EventType.SELL.value:
        if cancel_fully_consumed:
            account.status = transition(ACCOUNT_TRANSITIONS, account.status, "CANCEL_SELL", entity="账号")
    else:
        account.cost_amount = to_money(account.cost_amount) - amount
        if offset_event is None or (
            offset_event.event_type == EventType.BUY.value and cancel_fully_consumed
        ):
            account.status = transition(ACCOUNT_TRANSITIONS, account.status, "VOID", entity="账号")
    if actor is not None:
        account.updated_by = actor


def apply_installment_cancellation_account_effect(
    session: Session,
    order: Order,
    *,
    contract_type: str,
    actor: str,
) -> str | None:
    """终止分期合约后，按合约类型回流库存或终止提号账号。"""
    if order.account_id is None:
        return None
    account = session.get(Account, order.account_id)
    if account is None:
        raise NotFound("分期合约关联账号不存在", details={"account_id": order.account_id})
    action = "CANCEL_STOCK"
    account.status = transition(ACCOUNT_TRANSITIONS, account.status, action, entity="账号")
    account.updated_by = actor
    return account.status


def _retire_account_on_plain_cancel(
    session: Session,
    order: Order,
    *,
    form_extra: Mapping[str, Any] | None,
    actor: str,
) -> None:
    """无已登记事件的取消：把账号从库存里收回来。

    账号状态只由事件驱动，因此「无已登记事件」意味着本单从未改变过账号状态：

    - 每个账号只绑定当前订单；取消后它没有继续留在库存的业务依据，
      置 ``VOID`` 退出库存，避免可被误卖或阻止同账号重新建单；
    - **代挂（DG）**另按 ``platform_unlist_scope`` 区分：仅「本系统下架」终止
      账号，平台下架时账号仍在平台挂出（原口径，保持不变）。
    """
    if order.account_id is None:
        return
    account = session.get(Account, order.account_id)
    if account is None:
        return
    if order.order_type == "DG":
        if (form_extra or {}).get("platform_unlist_scope") != "SYSTEM":
            return
        if account.status == AccountStatus.WAITING.value:
            account.status = AccountStatus.VOID.value
            account.updated_by = actor
        return
    # VOID 在状态机里是终态（ACCOUNT_TRANSITIONS["VOID"] 为空），已 VOID 时天然跳过。
    if ACCOUNT_TRANSITIONS.get(account.status, {}).get("VOID") is not None:
        account.status = transition(
            ACCOUNT_TRANSITIONS, account.status, "VOID", entity="账号"
        )
        account.updated_by = actor


def cancel_order(
    session: Session,
    order_id: int,
    *,
    actor: str,
    reason: str,
    form_extra: Mapping[str, Any] | None = None,
    form_extra_scope: str | None = None,
    form_extra_context: Mapping[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> Order:
    """取消没有已登记业务/资金事件的订单。"""
    reason = _required_text(reason, field="reason", message="取消必须填写原因")
    order = get_order(session, order_id, user)
    posted_events = list(
        session.scalars(
            select(OrderEvent).where(
                OrderEvent.order_id == order.id,
                OrderEvent.is_posted.is_(True),
            )
        ).all()
    )
    if posted_events and not _can_cancel_after_consignment(order, posted_events):
        raise Validation("订单已有登记事件，不能直接取消，请先冲销")
    checked = validate_form_extra(
        session, order_type_code=form_extra_scope or "ORDERCANC", values=form_extra,
        context={**(form_extra_context or {}), "reason": reason},
    )
    order.status = transition(ORDER_TRANSITIONS, order.status, "CANCEL", entity="订单")
    _retire_account_on_plain_cancel(session, order, form_extra=form_extra, actor=actor)
    if checked:
        order.form_extra = {**(order.form_extra or {}), **checked}
    order.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.ORDER_CANCEL,
        entity_type="order",
        entity_id=order.order_no,
        actor=actor,
        after={"status": order.status},
        reason=reason.strip(),
    )
    return order


__all__ = [
    "apply_cancellation_account_effect",
    "apply_installment_cancellation_account_effect",
    "cancel_order",
    "cancellation_direction_for_offset_type",
    "get_cancellation_offset",
    "opposite_cancellation_direction",
]
