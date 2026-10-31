"""orders.events_rules：事件准入规则、冲销配对、交付与账号状态派生（ORD-02）。

由 `orders.events.post_event` 调用；本模块不负责事件落库与流水生成。
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from datetime import datetime
from decimal import Decimal
from typing import Any
from app.core.audit import record_audit
from app.core.business_numbering import event_no as next_event_no
from app.core.money import to_money
from app.domain.foundation import Pool
from app.foundation import service as foundation_service
from ._common import _required_text
from .cancellation_model import (
    apply_cancellation_account_effect,
    get_cancellation_offset,
    opposite_cancellation_direction,
)
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import (
    ErrorCode,
    NotFound,
    Validation,
)
from app.core.time import now_second
from app.core.state_machine import (
    ACCOUNT_TRANSITIONS,
    ORDER_TRANSITIONS,
    transition,
)
from app.domain.enums import (
    AccountStatus,
    AuditAction,
    CapitalType,
    EventType,
    PoolStatus,
)
from app.domain.trade import (
    Account,
    Installment,
    Order,
    OrderEvent,
)

def _assert_sellable_order(session: Session, order: Order) -> None:
    """库存账号售出必须建立在已采购入库之上。"""
    if order.order_type != "HS":
        if order.order_type == "TH":
            # 售出单本身不再重复 BUY：采购事实记在该账号的历史订单上
            # （提号入库单建单即登记 BUY，库存中心售出时会另开一张 TH 售出单）。
            # 故与 HS 同口径按账号维度追溯；账号缺失的历史数据回退到本订单维度。
            if order.account_id is not None:
                purchased = session.scalar(
                    select(OrderEvent.id)
                    .join(Order, Order.id == OrderEvent.order_id)
                    .where(
                        Order.account_id == order.account_id,
                        OrderEvent.event_type == EventType.BUY.value,
                        OrderEvent.is_posted.is_(True),
                    )
                    .limit(1)
                )
            else:
                purchased = session.scalar(
                    select(OrderEvent.id).where(
                        OrderEvent.order_id == order.id,
                        OrderEvent.event_type == EventType.BUY.value,
                        OrderEvent.is_posted.is_(True),
                    )
                )
            if purchased is None:
                raise Validation(
                    "TH 售出前必须存在已过账 BUY 事件（账号未采购入库）",
                    details={"order_no": order.order_no, "account_id": order.account_id},
                )
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
    if account.status != AccountStatus.WAITING.value:
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
        # account_id 为空只可能是建单快照缺游戏账号（有值时上方已自动建号）。
        if not (order.account_snapshot or {}).get("game_account"):
            raise Validation(
                "回收订单买入必须填写游戏账号，系统将据此创建库存账号",
                details={"field": "game_account"},
            )
        raise Validation("回收订单 BUY 必须关联库存账号")
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




# 兼容既有 events/service 内部调用路径；实际取消规则统一由 cancellation_model 管理。
_get_offset_event = get_cancellation_offset
_opposite_direction = opposite_cancellation_direction


def _post_deliver(
    session: Session,
    order: Order,
    *,
    occurred_on: date,
    actor: str,
    delivery_mode: str | None,
    note: str | None,
    bound_phone: str | None,
    bound_phone_owner: str | None,
    form_extra: Mapping[str, Any] | None,
    allow_installment_delivery: bool,
) -> tuple[OrderEvent, None]:
    """`DELIVER`：无金额、无现金流，必须记录交付方式与凭证（A04 / A05）。"""
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
    normalized_bound_phone = bound_phone.strip() if isinstance(bound_phone, str) and bound_phone.strip() else None
    normalized_bound_phone_owner = bound_phone_owner.strip() if isinstance(bound_phone_owner, str) and bound_phone_owner.strip() else None
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
        posted_at=now_second(),
        note=note,
        form_extra={
            **(dict(form_extra) if form_extra else {}),
            **({"bound_phone": normalized_bound_phone} if normalized_bound_phone is not None else {}),
            **({"bound_phone_owner": normalized_bound_phone_owner} if normalized_bound_phone_owner is not None else {}),
        } or None,
        created_by=actor,
        updated_by=actor,
    )
    session.add(event)
    if normalized_bound_phone is not None or normalized_bound_phone_owner is not None:
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
    if order.account_id is not None:
        account = session.get(Account, order.account_id)
        if account is not None:
            if normalized_bound_phone is not None:
                account.bound_phone = normalized_bound_phone
                account.updated_by = actor
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

    if event_type == EventType.BUY.value:
        account.cost_amount = to_money(account.cost_amount) + amount
        account.buy_date = order.trade_date
        next_action = "BUY_STOCK" if stock_type else "BUY_CREDIT"
        # 合约先行（建约已把账号置为分期中）时，BUY 仅补记成本，不重复转换。
        target = ACCOUNT_TRANSITIONS.get(account.status, {}).get(next_action)
        if target is not None:
            account.status = target
    elif event_type == EventType.COST.value:
        account.cost_amount = to_money(account.cost_amount) + amount
    elif event_type == EventType.SELL.value:
        account.status = transition(ACCOUNT_TRANSITIONS, account.status, "SELL", entity="账号")
    elif event_type == EventType.CANCEL.value:
        apply_cancellation_account_effect(
            account,
            amount,
            offset_event=offset_event,
            cancel_fully_consumed=cancel_fully_consumed,
            actor=actor,
        )
        return
    if actor is not None:
        account.updated_by = actor


__all__ = [
    "_apply_account_effect",
    "_assert_event_allowed",
    "_assert_pool_active",
    "_assert_sellable_order",
    "_get_offset_event",
    "_opposite_direction",
    "_post_deliver",
    "_resolve_pool",
]
