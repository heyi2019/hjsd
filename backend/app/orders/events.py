"""orders 事件登记服务（ORD-02）。"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.business_numbering import event_no as next_event_no
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.core.security import CurrentUser
from app.core.time import now_second
from app.core.state_machine import ORDER_TRANSITIONS, transition
from app.domain.enums import (
    AuditAction,
    Direction,
    EventType,
    OrderStatus,
    Portion,
)
from app.domain.trade import Account, Cashflow, Installment, Order, OrderEvent, OrderProfitAllocation
from app.domain.users import User
# 保留 re-export：既有调用方/测试按 `app.orders.events.foundation_service` 打桩，
# 拆分到 events_rules 后该路径仍需可解析（指向同一模块对象）。
from app.foundation import service as foundation_service
from app.orders.form_fields import validate_form_extra
from ._common import (
    _non_negative_money,
    _positive_money,
    _required_bool,
    _required_text,
)

# 事件 → 现金流方向 / 分类
EVENT_FLOW_MAP: dict[str, tuple[str, str]] = {
    EventType.BUY.value: (Direction.OUT.value, "BUY"),
    EventType.COST.value: (Direction.OUT.value, "COST"),
    EventType.SELL.value: (Direction.IN.value, "SELL"),
    EventType.PAYMENT.value: (Direction.IN.value, "PAYMENT"),
    EventType.CANCEL.value: (Direction.IN.value, "CANCEL"),
    EventType.REFUND.value: (Direction.OUT.value, "REFUND"),
}


def _auto_link_recovered_installment_sale(
    session: Session,
    order: Order,
    *,
    occurred_on: date,
    actor: str,
    note: str | None,
) -> None:
    """库存中心完成出售后，自动关联该账号最近一次未转售的回收处置。"""
    from app.value_added_services.service import link_recovered_sale

    link_recovered_sale(
        session,
        order,
        occurred_on=occurred_on,
        actor=actor,
        note=note,
    )

# --------------------------------------------------------------------- 事件
def post_event(
    session: Session,
    order_id: int,
    *,
    event_type: str,
    amount: Any = 0,
    occurred_on: date,
    actor: str,
    pool_id: int | None = None,
    pool_id2: int | None = None,
    amount2: Any = 0,
    portion: str = "PRINCIPAL",
    delivery_mode: str | None = None,
    offset_event_id: int | None = None,
    reason: str | None = None,
    refund_responsibility: str | None = None,
    operator_user_ids: list[int] | None = None,
    flow_category: str | None = None,
    note: str | None = None,
    bound_phone: str | None = None,
    bound_phone_owner: str | None = None,
    form_extra: Mapping[str, Any] | None = None,
    form_extra_scope: str | None = None,
    user: CurrentUser | None = None,
    allow_installment_payment: bool = False,
    allow_installment_delivery: bool = False,
    allow_installment_cancel: bool = False,
    defer_order_cancel: bool = False,
) -> tuple[OrderEvent, Cashflow | None]:
    """登记：状态校验 → 池路由 → 事件落库 → 现金流派生 → 账号/订单状态，同一事务。"""
    from .service import _create_inline_inventory_account, get_order

    allow_installment_payment = _required_bool(
        allow_installment_payment, field="allow_installment_payment"
    )
    allow_installment_delivery = _required_bool(
        allow_installment_delivery, field="allow_installment_delivery"
    )
    allow_installment_cancel = _required_bool(
        allow_installment_cancel, field="allow_installment_cancel"
    )
    defer_order_cancel = _required_bool(
        defer_order_cancel, field="defer_order_cancel"
    )
    if defer_order_cancel and not allow_installment_cancel:
        raise Validation("defer_order_cancel 只能用于分期取消流程")
    try:
        EventType(event_type)
    except ValueError as exc:
        raise Validation(
            f"事件类型必须为 {EventType.values()}",
            details={"field": "event_type", "value": event_type},
        ) from exc
    try:
        portion = Portion(portion).value
    except ValueError as exc:
        raise Validation(
            f"portion 必须为 {Portion.values()}",
            details={"field": "portion", "value": portion},
        ) from exc

    order = get_order(session, order_id, user)
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
        raise NotFound("资金池不存在", details={"pool_id": pool_id})
    can_refund_completed = (
        event_type == EventType.REFUND.value
        and order.status == OrderStatus.COMPLETED.value
    )
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
    can_validate_completed_cost = (
        event_type == EventType.COST.value
        and order.status == OrderStatus.COMPLETED.value
        and order.order_type == "HS"
    )
    if order.status not in {OrderStatus.ACTIVE.value, OrderStatus.INSTALLMENT.value} and not (
        can_refund_completed
        or can_cancel_completed
        or can_reopen_for_buy
        or can_validate_completed_sell
        or can_validate_completed_cost
    ):
        raise Conflict(
            f"订单 {order.order_no} 当前状态 {order.status}，不能登记事件",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"order_no": order.order_no, "current_status": order.status},
        )

    # HS/TH BUY：订单未关联库存账号时用建单快照里的账号资料补建（正常流程建单时
    # 已建号，此处是 API 直调/异常数据的兜底；游戏账号必填是建号前提）。
    # 2026-10-28 去冗余：平铺列已删除，账号资料统一从 account_snapshot 读取。
    _buy_snapshot = order.account_snapshot or {}
    if (
        order.order_type in {"HS", "TH"}
        and event_type == EventType.BUY.value
        and order.account_id is None
        and _buy_snapshot.get("game_account")
    ):
        account = _create_inline_inventory_account(
            session, order_type=order.order_type,
            game_account=_buy_snapshot["game_account"], actor=actor,
            game_type=_buy_snapshot.get("game_type"),
            game_password=_buy_snapshot.get("game_password"),
            channel_region=_buy_snapshot.get("channel_region"),
            bound_phone=_buy_snapshot.get("bound_phone"),
            has_secondary=_buy_snapshot.get("has_secondary"),
            account_note=_buy_snapshot.get("note"),
            extra_values=_buy_snapshot.get("extra_values"),
        )
        order.account_id = account.id

    _assert_event_allowed(
        session,
        order,
        event_type,
        offset_event_id=offset_event_id,
        reason=reason,
        allow_installment_payment=allow_installment_payment,
        allow_installment_cancel=allow_installment_cancel,
    )

    if event_type == EventType.DELIVER.value:
        return _post_deliver(
            session,
            order,
            occurred_on=occurred_on,
            actor=actor,
            delivery_mode=delivery_mode,
            note=note,
            bound_phone=bound_phone,
            bound_phone_owner=bound_phone_owner,
            form_extra=form_extra,
            allow_installment_delivery=allow_installment_delivery,
        )

    if event_type == EventType.SELL.value:
        _assert_sellable_order(session, order)

    direction, category = EVENT_FLOW_MAP[event_type]
    if flow_category is not None:
        if (
            not isinstance(flow_category, str)
            or event_type != EventType.COST.value
            or flow_category not in {"FEE", "DESIGN", "OTHER"}
        ):
            raise Validation(
                "仅 COST 事件可使用 FEE、DESIGN 或 OTHER 资金分类",
                details={"event_type": event_type, "flow_category": flow_category},
            )
        category = flow_category

    # 初始买入(BUY)对应的号价/成本允许为 0：提号表单将该字段设为选填时前端以 0 兜底，
    # 此处需放行 0；其余资金事件金额必须为正数，以保持账务完整。
    if event_type == EventType.BUY.value:
        money = _non_negative_money(amount, field="amount")
    else:
        money = _positive_money(amount, field="amount")
    if event_type == EventType.REFUND.value:
        _required_text(reason, field="reason", message="退款必须填写原因")
        refund_responsibility = refund_responsibility or "COMPANY"
        installment = session.scalar(select(Installment).where(Installment.order_id == order.id))
        delivered = session.scalar(select(OrderEvent.id).where(OrderEvent.order_id == order.id, OrderEvent.event_type == (EventType.DELIVER.value if installment else EventType.SELL.value), OrderEvent.is_posted.is_(True)))
        if delivered is None:
            raise Validation("交付前请使用取消或冲销，交付后才能退款")
        if refund_responsibility not in {"COMPANY", "CUSTOMER", "CONSIGNOR", "PLATFORM", "OTHER"}:
            raise Validation(
                "退款责任方必须为 COMPANY、CUSTOMER、CONSIGNOR、PLATFORM 或 OTHER",
                details={"field": "refund_responsibility"},
            )
        if offset_event_id is not None:
            raise Validation("退款不使用 offset_event_id")
        received = session.scalar(
            select(func.coalesce(func.sum(OrderEvent.amount), 0)).where(
                OrderEvent.order_id == order.id,
                OrderEvent.event_type.in_((EventType.SELL.value, EventType.PAYMENT.value)),
                OrderEvent.is_posted.is_(True),
            )
        ) or 0
        refunded = session.scalar(
            select(func.coalesce(func.sum(OrderEvent.amount), 0)).where(
                OrderEvent.order_id == order.id,
                OrderEvent.event_type == EventType.REFUND.value,
                OrderEvent.is_posted.is_(True),
            )
        ) or 0
        remaining_refundable = to_money(received) - to_money(refunded)
        if money > remaining_refundable:
            raise Validation(
                f"退款金额超过可退余额 {remaining_refundable}",
                details={"remaining_refundable": str(remaining_refundable), "amount": str(money)},
            )
    offset = None
    cancel_fully_consumed = False
    if event_type == EventType.CANCEL.value and offset_event_id is not None:
        offset = _get_offset_event(session, offset_event_id, order_id=order.id)
        if pool_id is not None and pool_id != offset.pool_id:
            raise Validation(
                "冲销必须沿用被冲销事件的资金池",
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
    resolved_pool_id = (
        pool_id
        or (offset.pool_id if offset is not None else None)
        or _resolve_pool(session, order, portion).id
    )
    if user is not None and not user.can_see_pool(resolved_pool_id):
        raise NotFound("资金池不存在", details={"pool_id": resolved_pool_id})
    _assert_pool_active(session, resolved_pool_id)
    # 售出拆分：同一笔 SELL 可同时进入两个资金池（资金账户1 + 资金账户2）。
    # 仅当显式传入 pool_id2 时启用；金额2 必须为正，且二者须成对出现。
    secondary_money: Decimal = Decimal("0")
    resolved_pool_id2: int | None = None
    if pool_id2 is not None:
        secondary_money = _non_negative_money(amount2, field="amount2")
        if secondary_money <= 0:
            raise Validation("售出金额2 必须为正数", details={"field": "amount2"})
        resolved_pool_id2 = pool_id2
        if user is not None and not user.can_see_pool(resolved_pool_id2):
            raise NotFound("资金池不存在", details={"pool_id": resolved_pool_id2})
        _assert_pool_active(session, resolved_pool_id2)
    elif amount2 is not None:
        if _non_negative_money(amount2, field="amount2") > 0:
            raise Validation("填写了售出金额2 必须选择资金账户2", details={"field": "pool_id2"})
    cancel_direction = Direction.IN.value
    if event_type == EventType.CANCEL.value:
        cancel_direction = _opposite_direction(offset_event_id, session, order_id=order.id)

    normalized_bound_phone = bound_phone.strip() if isinstance(bound_phone, str) and bound_phone.strip() else None
    normalized_bound_phone_owner = bound_phone_owner.strip() if isinstance(bound_phone_owner, str) and bound_phone_owner.strip() else None
    event_form_extra = validate_form_extra(
        session, order_type_code=(form_extra_scope or "REFUND"), values=form_extra
    )
    if event_type == EventType.SELL.value and (normalized_bound_phone is not None or normalized_bound_phone_owner is not None):
        account = session.get(Account, order.account_id) if order.account_id is not None else None
        snapshot = dict(order.account_snapshot or {})
        if not snapshot.get("game_account") and account is not None and account.game_account:
            snapshot.update({
                "game_account": account.game_account,
                "game_type": account.game_type,
                "game_password": account.game_password,
                "channel_region": account.channel_region,
                "has_secondary": account.has_secondary,
                "platform": account.platform,
                "note": account.note,
            })
        if normalized_bound_phone is not None:
            snapshot["bound_phone"] = normalized_bound_phone
        if normalized_bound_phone_owner is not None:
            snapshot["bound_phone_owner"] = normalized_bound_phone_owner
        if snapshot.get("game_account"):
            order.account_snapshot = snapshot
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
        amount=money + secondary_money,
        portion=portion,
        occurred_on=occurred_on,
        pool_id=resolved_pool_id,
        offset_event_id=offset_event_id,
        reason=reason,
        refund_responsibility=refund_responsibility,
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

    # 订单动作继续自动生成独立资金流水；事件与流水分表保存，并通过
    # order_id / order_event_id 关联，资金域只负责实际收支记录。
    from app.finance import service as finance_service

    flow = finance_service.create_business_event_cashflow(
        session,
        pool_id=event.pool_id,
        occurred_on=occurred_on,
        direction=direction,
        category=category,
        amount=money,
        order_id=order.id,
        order_event_id=event.id,
        actor=actor,
        event_type=event_type,
        note=note,
    )
    if resolved_pool_id2 is not None:
        finance_service.create_business_event_cashflow(
            session,
            pool_id=resolved_pool_id2,
            occurred_on=occurred_on,
            direction=direction,
            category=category,
            amount=secondary_money,
            order_id=order.id,
            order_event_id=event.id,
            actor=actor,
            event_type=event_type,
            note=note,
        )

    _apply_account_effect(
        session,
        order,
        event_type,
        money,
        offset_event=offset,
        cancel_fully_consumed=(offset is None or cancel_fully_consumed),
        actor=actor,
    )
    if event_type == EventType.SELL.value:
        # 非分期订单以 SELL 作为终态事件；分期订单不会进入此分支，
        # 它们必须通过 PAYMENT -> DELIVER 完成闭环。
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
        (offset is None or cancel_fully_consumed) and not defer_order_cancel
    ):
        # 冲销事件闭环：订单进入 CANCELLED，此后不再接受任何新事件
        order.status = transition(
            ORDER_TRANSITIONS, order.status, "CANCEL", entity="订单"
        )
    session.flush()

    # BUY/SELL 收益人自动绑定动作执行人，避免手工选错人员。
    if event_type in {EventType.BUY.value, EventType.SELL.value}:
        actor_id = session.scalar(select(User.id).where(User.username == actor))
        if actor_id is not None:
            allocations = session.scalars(
                select(OrderProfitAllocation).where(
                    OrderProfitAllocation.order_id == order.id,
                    OrderProfitAllocation.allocation_type == event_type,
                )
            ).all()
            for allocation in allocations:
                allocation.user_id = actor_id
                allocation.updated_by = actor

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
            "flow_no": flow.flow_no,
        },
        reason=reason,
    )
    return event, flow

from .events_rules import (
    _apply_account_effect,
    _assert_event_allowed,
    _assert_pool_active,
    _assert_sellable_order,
    _get_offset_event,
    _opposite_direction,
    _post_deliver,
    _resolve_pool,
)

__all__ = [
    "_apply_account_effect",
    "_opposite_direction",
    "foundation_service",
    "post_event",
]
