"""orders 事件登记服务（ORD-02）。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.business_numbering import cashflow_no as next_cashflow_no
from app.core.business_numbering import event_no as next_event_no
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.core.periods import assert_period_open
from app.core.security import CurrentUser
from app.core.state_machine import ACCOUNT_TRANSITIONS, ORDER_TRANSITIONS, transition
from app.domain.enums import (
    AccountStatus,
    AuditAction,
    CapitalType,
    Direction,
    EventType,
    InventoryType,
    InstallmentContractType,
    InstallmentDispositionAction,
    Nature,
    OrderStatus,
    Portion,
    PoolStatus,
)
from app.domain.foundation import Pool
from app.domain.trade import Account, Cashflow, Installment, InstallmentDisposition, Order, OrderEvent, OrderProfitAllocation
from app.domain.users import User
from app.foundation import service as foundation_service
from app.finance.attributes import accounting_attribute_for_order_event
from ._common import _positive_money, _required_bool, _required_text

# 事件 → 现金流方向 / 性质 / 分类
EVENT_FLOW_MAP: dict[str, tuple[str, str, str]] = {
    EventType.BUY.value: (Direction.OUT.value, Nature.BUSINESS_OUT.value, "BUY"),
    EventType.COST.value: (Direction.OUT.value, Nature.BUSINESS_OUT.value, "COST"),
    EventType.SELL.value: (Direction.IN.value, Nature.BUSINESS_IN.value, "SELL"),
    EventType.PAYMENT.value: (Direction.IN.value, Nature.BUSINESS_IN.value, "PAYMENT"),
    EventType.CANCEL.value: (Direction.IN.value, Nature.BUSINESS_IN.value, "CANCEL"),
    EventType.REFUND.value: (Direction.OUT.value, Nature.BUSINESS_OUT.value, "REFUND"),
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
    from app.installments.service import link_recovered_sale

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
    portion: str = "PRINCIPAL",
    delivery_mode: str | None = None,
    offset_event_id: int | None = None,
    reason: str | None = None,
    refund_responsibility: str | None = None,
    flow_category: str | None = None,
    note: str | None = None,
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
    assert_period_open(session, occurred_on, operation="登记业务事件")
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
    if order.status != OrderStatus.ACTIVE.value and not (
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

    if order.order_type in {"HS", "TH"} and event_type == EventType.BUY.value and order.account_id is None and order.game_account:
        account = _create_inline_inventory_account(
            session, order_type=order.order_type, game_account=order.game_account, actor=actor,
            game_type=order.game_type, game_password=order.game_password,
            channel_region=order.channel_region, bound_phone=order.bound_phone,
            has_secondary=order.has_secondary, account_note=order.account_note,
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
            allow_installment_delivery=allow_installment_delivery,
        )

    if event_type == EventType.SELL.value:
        _assert_sellable_order(session, order)

    direction, nature, category = EVENT_FLOW_MAP[event_type]
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
    fund_nature, accounting_attribute = accounting_attribute_for_order_event(
        order.order_type, event_type
    )
    resolved_pool_id = (
        pool_id
        or (offset.pool_id if offset is not None else None)
        or _resolve_pool(session, order, portion, fund_nature=fund_nature).id
    )
    if user is not None and not user.can_see_pool(resolved_pool_id):
        raise NotFound("资金池不存在", details={"pool_id": resolved_pool_id})
    _assert_pool_active(session, resolved_pool_id)
    cancel_direction = Direction.IN.value
    if event_type == EventType.CANCEL.value:
        cancel_direction = _opposite_direction(offset_event_id, session, order_id=order.id)

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
        refund_responsibility=refund_responsibility,
        note=note,
        is_posted=True,
        posted_at=datetime.now(),
        created_by=actor,
        updated_by=actor,
    )
    session.add(event)
    session.flush()

    if event_type == EventType.CANCEL.value:
        direction = cancel_direction

    flow = Cashflow(
        flow_no=next_cashflow_no(
            session, order_no=order.order_no, order_id=order.id, category=category
        ),
        pool_id=event.pool_id,
        occurred_on=occurred_on,
        nature=nature,
        fund_nature=fund_nature,
        accounting_attribute=accounting_attribute,
        category=category,
        direction=direction,
        amount=money,
        order_id=order.id,
        order_event_id=event.id,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(flow)

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


def _assert_sellable_order(session: Session, order: Order) -> None:
    """库存账号售出必须建立在已采购入库之上。"""
    if order.order_type != "HS":
        if order.order_type == "TH":
            purchased = session.scalar(
                select(OrderEvent.id).where(
                    OrderEvent.order_id == order.id,
                    OrderEvent.event_type == EventType.BUY.value,
                    OrderEvent.is_posted.is_(True),
                )
            )
            if purchased is None:
                raise Validation("TH 收款前必须存在 BUY 事件")
        return

    if session.scalar(
        select(Installment.id).where(Installment.order_id == order.id)
    ) is not None:
        raise Validation("HS 已建立分期合约，必须通过 PAYMENT 收款并在结清后交付")
    if order.account_id is None:
        raise Validation(
            "自营账号售出必须关联已回收账号",
            details={"order_type": order.order_type, "account_id": None},
        )

    account = session.get(Account, order.account_id)
    if account is None:
        raise NotFound(f"账号 {order.account_id} 不存在", details={"account_id": order.account_id})
    if account.status != AccountStatus.IN_STOCK.value:
        raise Validation(
            "账号必须先完成回收并进入库存后才能售出",
            details={"account_status": account.status, "account_id": account.id},
        )

    purchased = session.scalar(
        select(OrderEvent.id)
        .join(Order, Order.id == OrderEvent.order_id)
        .where(
            Order.account_id == account.id,
            OrderEvent.event_type == EventType.BUY.value,
            OrderEvent.is_posted.is_(True),
        )
        .limit(1)
    )
    if purchased is None:
        raise Validation(
            "账号缺少采购入库记录，不能售出",
            details={"account_id": account.id},
        )


def _assert_event_allowed(
    session: Session,
    order: Order,
    event_type: str,
    *,
    offset_event_id: int | None = None,
    reason: str | None = None,
    allow_installment_payment: bool = False,
    allow_installment_cancel: bool = False,
) -> None:
    """按业务类型限制事件组合，避免只依赖资金路由间接拦截非法动作。"""
    if order.order_type == "HS" and event_type == EventType.BUY.value and order.account_id is None:
        raise Validation("回收订单 BUY 必须关联库存账号")
    if order.order_type == "DFQ" and event_type == EventType.BUY.value:
        contract_type = session.scalar(
            select(Installment.contract_type).where(Installment.order_id == order.id)
        )
        if contract_type != InstallmentContractType.ADVANCE_PURCHASE.value:
            raise Validation("DFQ BUY 必须先创建 ADVANCE_PURCHASE 分期合约")
    if order.order_type == "DG" and event_type in {
        EventType.BUY.value,
        EventType.COST.value,
    }:
        raise Validation("代挂业务不允许 BUY 或 COST 事件")
    if order.order_type == "HS" and event_type == EventType.COST.value:
        if order.account_id is None:
            raise Validation("回收订单 COST 必须关联库存账号")
        account = session.get(Account, order.account_id)
        if account is None:
            raise NotFound(
                f"账号 {order.account_id} 不存在",
                details={"account_id": order.account_id},
            )
        if account.status in {
            AccountStatus.SOLD.value,
            AccountStatus.VOID.value,
        }:
            raise Validation("已售账号不能新增 COST")
    if order.order_type == "DFQ" and event_type == EventType.SELL.value:
        raise Validation("代分期只能通过 PAYMENT 收款，不能直接 SELL")
    if order.order_type in {"TH", "DG"} and event_type == EventType.SELL.value:
        installment = session.scalar(
            select(Installment).where(Installment.order_id == order.id)
        )
        if installment is not None:
            raise Validation(
                f"{order.order_type} 已建立分期合约，只能通过 PAYMENT 收款，不能直接 SELL"
            )
    if event_type == EventType.SELL.value and session.scalar(
        select(OrderEvent.id).where(
            OrderEvent.order_id == order.id,
            OrderEvent.event_type == EventType.SELL.value,
            OrderEvent.is_posted.is_(True),
        )
    ) is not None:
        raise Validation("每张订单只能登记一次 SELL")
    if event_type == EventType.PAYMENT.value:
        installment = session.scalar(
            select(Installment.id).where(Installment.order_id == order.id)
        )
        if installment is None:
            raise Validation("PAYMENT 必须关联分期合约")
        if not allow_installment_payment:
            raise Validation("PAYMENT 必须通过分期收款流程")
    if event_type == EventType.CANCEL.value:
        _required_text(reason, field="reason", message="CANCEL 必须填写冲销原因")
        if offset_event_id is None:
            raise Validation(
                "事件型 CANCEL 必须指定 offset_event_id",
                details={"field": "offset_event_id"},
            )
        if offset_event_id is not None:
            offset = _get_offset_event(session, offset_event_id, order_id=order.id)
            if offset.event_type == EventType.PAYMENT.value:
                if not allow_installment_cancel:
                    raise Validation(
                        "分期收款不能直接冲销，请通过分期取消流程处理",
                        details={"offset_event_id": offset_event_id},
                    )
                installment = session.scalar(
                    select(Installment).where(Installment.order_id == order.id)
                )
                if installment is None:
                    raise Validation("PAYMENT 冲销必须关联分期合约")




def _opposite_direction(
    offset_event_id: int | None,
    session: Session,
    *,
    order_id: int | None = None,
) -> str:
    if offset_event_id is None:
        return Direction.IN.value
    offset = _get_offset_event(session, offset_event_id, order_id=order_id)
    if offset.event_type in {EventType.BUY.value, EventType.COST.value}:
        return Direction.IN.value
    return Direction.OUT.value


def _get_offset_event(
    session: Session, offset_event_id: int, *, order_id: int | None = None
) -> OrderEvent:
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
    if offset.event_type not in {
        EventType.BUY.value,
        EventType.COST.value,
        EventType.SELL.value,
        EventType.PAYMENT.value,
    }:
        raise Validation(
            "只能冲销有金额的业务事件",
            details={"offset_event_id": offset_event_id, "event_type": offset.event_type},
        )
    return offset


def _post_deliver(
    session: Session,
    order: Order,
    *,
    occurred_on: date,
    actor: str,
    delivery_mode: str | None,
    note: str | None,
    allow_installment_delivery: bool,
) -> tuple[OrderEvent, None]:
    """`DELIVER`：无金额、无现金流，必须记录交付方式与凭证（DFQ-01-07 / A04 / A05）。"""
    modes = ("PLATFORM_OPERATOR", "CUSTOMER_SELF")
    if delivery_mode not in modes:
        raise Validation(
            f"DELIVER 必须提供 delivery_mode，取值 {modes}",
            code=ErrorCode.DELIVERY_CONDITION_UNMET,
            details={"field": "delivery_mode", "value": delivery_mode},
        )
    if not isinstance(note, str) or not note.strip():
        raise Validation(
            "DELIVER 必须记录交付凭证说明",
            code=ErrorCode.DELIVERY_CONDITION_UNMET,
            details={"field": "note"},
        )
    note = note.strip()
    installment = session.scalar(
        select(Installment).where(Installment.order_id == order.id)
    )
    if installment is None:
        raise Validation(
            "DELIVER 必须通过分期合约交付",
            code=ErrorCode.DELIVERY_CONDITION_UNMET,
            details={"order_no": order.order_no},
        )
    if installment.status != "SETTLED":
        raise Validation(
            f"分期合约 {installment.inst_no} 未结清，不能 DELIVER",
            code=ErrorCode.DELIVERY_CONDITION_UNMET,
            details={"inst_no": installment.inst_no, "status": installment.status},
        )
    if not allow_installment_delivery:
        raise Validation("DELIVER 必须通过分期交付流程")
    event = OrderEvent(
        event_no=next_event_no(
            session,
            order_no=order.order_no,
            order_id=order.id,
            event_type=EventType.DELIVER.value,
        ),
        order_id=order.id,
        event_type=EventType.DELIVER.value,
        amount=Decimal("0"),
        occurred_on=occurred_on,
        pool_id=None,
        delivery_mode=delivery_mode,
        is_posted=True,
        posted_at=datetime.now(),
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(event)
    if order.account_id is not None:
        account = session.get(Account, order.account_id)
        if account is not None:
            account.status = AccountStatus.SOLD.value
            account.updated_by = actor
    order.status = transition(
        ORDER_TRANSITIONS, order.status, "COMPLETE", entity="订单"
    )
    session.flush()
    record_audit(
        session,
        action=AuditAction.DELIVER_CREATE,
        entity_type="order_event",
        entity_id=event.event_no,
        actor=actor,
        after={"order_no": order.order_no, "delivery_mode": delivery_mode},
    )
    return event, None


def _resolve_pool(
    session: Session,
    order: Order,
    portion: str,
    *,
    fund_nature: str | None = None,
) -> Pool:
    pool = foundation_service.resolve_default_pool(
        session, order.order_type, portion, fund_nature=fund_nature
    )
    if pool is None:
        raise Validation(
            f"业务 {order.order_type} 未配置 {portion} 资金池路由",
            code=ErrorCode.POOL_ROUTE_MISSING,
            details={
                "order_type": order.order_type,
                "portion": portion,
                "fund_nature": fund_nature,
            },
        )
    return pool


def _assert_pool_active(session: Session, pool_id: int) -> Pool:
    """停用池不得用于新记录（QLT-01-04：主数据一致性校验）。"""
    pool = session.get(Pool, pool_id)
    if pool is None:
        raise NotFound(f"资金池 {pool_id} 不存在", details={"pool_id": pool_id})
    if pool.status != PoolStatus.ACTIVE.value:
        raise Validation(
            f"资金池 {pool.code} 已停用，不能登记新流水",
            code=ErrorCode.POOL_DISABLED,
            details={"pool_code": pool.code, "status": pool.status},
        )
    return pool


def _apply_account_effect(
    session: Session,
    order: Order,
    event_type: str,
    amount: Decimal,
    *,
    offset_event: OrderEvent | None = None,
    cancel_fully_consumed: bool = True,
    actor: str | None = None,
) -> None:
    """账号状态与成本只由事件驱动（ACC-01-03/04）。"""
    if order.account_id is None:
        return
    account = session.get(Account, order.account_id)
    if account is None:
        return
    stock_type = order.order_type == "HS" or order.capital_type == CapitalType.STOCK.value
    credit_type = order.capital_type == CapitalType.CREDIT.value

    if event_type == EventType.BUY.value:
        account.cost_amount = to_money(account.cost_amount) + amount
        account.buy_date = order.trade_date
        account.status = transition(
            ACCOUNT_TRANSITIONS,
            account.status,
            "BUY_STOCK" if stock_type else "BUY_CREDIT",
            entity="账号",
        )
    elif event_type == EventType.COST.value:
        account.cost_amount = to_money(account.cost_amount) + amount
    elif event_type == EventType.SELL.value:
        account.status = transition(ACCOUNT_TRANSITIONS, account.status, "SELL", entity="账号")
    elif event_type == EventType.CANCEL.value:
        if offset_event is not None and offset_event.event_type == EventType.SELL.value:
            if cancel_fully_consumed:
                account.status = transition(
                    ACCOUNT_TRANSITIONS,
                    account.status,
                    "CANCEL_SELL_END" if account.inventory_type == InventoryType.PICKUP.value else "CANCEL_SELL",
                    entity="账号",
                )
            if actor is not None:
                account.updated_by = actor
            return
        if offset_event is not None and offset_event.event_type == EventType.PAYMENT.value:
            # 分期收款取消只产生原路退款现金流，不改写账号成本。
            if actor is not None:
                account.updated_by = actor
            return
        account.cost_amount = to_money(account.cost_amount) - amount
        if offset_event is None or (
            offset_event.event_type == EventType.BUY.value and cancel_fully_consumed
        ):
            account.status = transition(
                ACCOUNT_TRANSITIONS, account.status, "VOID", entity="账号"
            )
    if actor is not None:
        account.updated_by = actor

__all__ = [
    "post_event",
]

