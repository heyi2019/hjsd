"""orders.events_rules：事件准入规则、冲销配对、交付与账号状态派生（ORD-02）。

由 `orders.events.post_event` 调用；本模块不负责事件落库与流水生成。
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from decimal import Decimal
from typing import Any
from app.shared.audit import record_audit
from app.shared.business_numbering import event_no as next_event_no
from app.core.money import to_money
from app.domain.foundation import Pool
from app.settings.field_definitions.order_types import get_order_type_by_code
from app.settings.field_definitions.pools import require_default_pool
from .._common import _required_text
from ..shared.cancellation_model import (
    apply_cancellation_account_effect,
    get_cancellation_offset,
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
    EventType,
    OrderStatus,
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
            # 提号订单的采购与售出都登记在同一来源订单。
            purchased = session.scalar(
                select(OrderEvent.id)
                .where(
                    OrderEvent.order_id == order.id,
                    OrderEvent.event_type == EventType.BUY.value,
                    OrderEvent.is_posted.is_(True),
                )
                .limit(1)
            )
            if purchased is None:
                cancelled_installment = session.scalar(select(Installment.id).where(
                    Installment.order_id == order.id, Installment.status == "CANCELLED"
                ).limit(1))
                account = session.get(Account, order.account_id) if order.account_id is not None else None
                if cancelled_installment is None or account is None or account.status != AccountStatus.WAITING.value:
                    raise Validation(
                        "TH 售出前必须在本订单登记已过账 BUY 事件",
                        details={"order_no": order.order_no, "account_id": order.account_id},
                    )
        return

    if session.scalar(
        select(Installment.id).where(Installment.order_id == order.id, Installment.status != "CANCELLED")
    ) is not None:
        raise Validation("HS 已建立分期合约，必须通过分期收款并在结清后交付")
    if order.account_id is None:
        raise Validation(
            "回收账号售出必须关联已回收的库存账号",
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
        .where(
            OrderEvent.order_id == order.id,
            OrderEvent.event_type == EventType.BUY.value,
            OrderEvent.is_posted.is_(True),
        )
        .limit(1)
    )
    if purchased is None:
        raise Validation(
            "本订单缺少采购入库记录，不能售出",
            details={"order_no": order.order_no, "account_id": account.id},
        )


def _assert_event_allowed(
    session: Session,
    order: Order,
    event_type: str,
    *,
    offset_event_id: int | None = None,
    reason: str | None = None,
) -> None:
    """按业务类型限制事件组合，避免只依赖资金账户解析间接拦截非法动作。"""
    if order.order_type == "HS" and event_type == EventType.BUY.value and order.account_id is None:
        # 回收订单在建单时必须已完成账号绑定；事件登记不再补建库存账号。
        if not (order.account_snapshot or {}).get("game_account"):
            raise Validation(
                "回收订单建单时必须填写游戏账号并绑定库存账号",
                details={"field": "game_account"},
            )
        raise Validation("回收订单 BUY 必须关联建单时绑定的库存账号")
    if order.order_type == "DG" and event_type == EventType.BUY.value:
        raise Validation("代挂业务不允许 BUY 事件")
    if order.order_type in {"TH", "DG"} and event_type == EventType.SELL.value:
        installment = session.scalar(
            select(Installment).where(Installment.order_id == order.id, Installment.status != "CANCELLED")
        )
        if installment is not None:
            raise Validation(
                f"{order.order_type} 已建立分期合约，只能通过分期收款，不能重复登记 SELL"
            )
    if event_type == EventType.SELL.value:
        last_sell_id = session.scalar(
            select(OrderEvent.id).where(
                OrderEvent.order_id == order.id,
                OrderEvent.event_type == EventType.SELL.value,
                OrderEvent.is_posted.is_(True),
            ).order_by(OrderEvent.id.desc()).limit(1)
        )
        if last_sell_id is not None:
            # 重开 BUY（COMPLETED → BUY → ACTIVE）后允许再次售出闭环；
            # 只在「最近一次 SELL 之后没有新的 BUY」时才拦重复售出。
            last_buy_id = session.scalar(
                select(OrderEvent.id).where(
                    OrderEvent.order_id == order.id,
                    OrderEvent.event_type == EventType.BUY.value,
                    OrderEvent.is_posted.is_(True),
                ).order_by(OrderEvent.id.desc()).limit(1)
            )
            if last_buy_id is None or last_buy_id < last_sell_id:
                account = session.get(Account, order.account_id) if order.account_id is not None else None
                cancelled_sale = session.scalar(select(OrderEvent.id).where(
                    OrderEvent.order_id == order.id, OrderEvent.event_type == "CANCEL",
                    OrderEvent.offset_event_id == last_sell_id, OrderEvent.is_posted.is_(True),
                ).limit(1))
                cancelled_installment = session.scalar(select(Installment.id).where(
                    Installment.order_id == order.id, Installment.status == "CANCELLED"
                ).limit(1))
                last_sell = session.get(OrderEvent, last_sell_id)
                cancelled_installment_sale = cancelled_installment is not None and last_sell is not None and (last_sell.form_extra or {}).get("sale_mode") == "INSTALLMENT"
                if account is None or account.status != AccountStatus.WAITING.value or (cancelled_sale is None and not cancelled_installment_sale):
                    raise Validation("每张订单只能登记一次 SELL；重开 BUY 或取消售出并回到库存后可再次售出")
    if event_type == EventType.CANCEL.value:
        _required_text(reason, field="reason", message="CANCEL 必须填写冲销原因")
        if offset_event_id is None:
            raise Validation(
                "事件型 CANCEL 必须指定 offset_event_id",
                details={"field": "offset_event_id"},
            )
        if offset_event_id is not None:
            get_cancellation_offset(session, offset_event_id, order_id=order.id)




def _post_deliver(
    session: Session,
    order: Order,
    *,
    occurred_on: date,
    actor: str,
    delivery_direction: str | None,
    note: str | None,
    bound_phone: str | None,
    bound_phone_owner: str | None,
    form_extra: Mapping[str, Any] | None,
    allow_installment_delivery: bool,
) -> tuple[OrderEvent, None]:
    """`DELIVER`：无金额、无现金流，必须记录交付方向、凭证与账号绑定（A04 / A05）。"""
    direction = (delivery_direction or "SELL").strip().upper()
    if direction not in {"BUY", "SELL"}:
        raise Validation(
            "DELIVER 的 delivery_direction 必须为 BUY 或 SELL",
            details={"field": "delivery_direction", "value": delivery_direction},
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
    latest_sell_id = None
    if direction == "SELL":
        latest_sell_id = session.scalar(
            select(OrderEvent.id).where(
                OrderEvent.order_id == order.id,
                OrderEvent.event_type == EventType.SELL.value,
                OrderEvent.is_posted.is_(True),
            ).order_by(OrderEvent.id.desc()).limit(1)
        )
    delivery_query = select(OrderEvent).where(
        OrderEvent.order_id == order.id,
        OrderEvent.event_type == EventType.DELIVER.value,
        OrderEvent.is_posted.is_(True),
    )
    if latest_sell_id is not None:
        # 撤销后重售仍使用同一订单；按登记顺序区分新旧交易，日期可能被补录。
        delivery_query = delivery_query.where(OrderEvent.id > latest_sell_id)
    previous_delivery = next(
        (
            event
            for event in session.scalars(delivery_query).all()
            if (event.form_extra or {}).get("delivery_direction") == direction
        ),
        None,
    )
    if previous_delivery is not None:
        delivery_label = "买号" if direction == "BUY" else "卖号"
        raise Validation(
            f"该订单已经登记过{delivery_label}交付",
            code=ErrorCode.DELIVERY_CONDITION_UNMET,
            details={"delivery_direction": direction},
        )
    installment = session.scalar(
        select(Installment).where(Installment.order_id == order.id, Installment.status != "CANCELLED").order_by(Installment.id.desc())
    )
    if installment is not None:
        if installment.status != "SETTLED":
            raise Validation(
                f"分期合约 {installment.inst_no} 未结清，不能 DELIVER",
                code=ErrorCode.DELIVERY_CONDITION_UNMET,
                details={"inst_no": installment.inst_no, "status": installment.status},
            )
        if not allow_installment_delivery:
            raise Validation("分期 DELIVER 必须通过分期交付流程")
    else:
        required_event = EventType.SELL.value if direction == "SELL" else EventType.BUY.value
        has_required_event = latest_sell_id if direction == "SELL" else session.scalar(
            select(OrderEvent.id).where(
                OrderEvent.order_id == order.id,
                OrderEvent.event_type == required_event,
                OrderEvent.is_posted.is_(True),
            )
        )
        if has_required_event is None:
            label = "售出" if direction == "SELL" else "买入"
            delivery_label = "卖号" if direction == "SELL" else "买号"
            raise Validation(
                f"登记{delivery_label}交付前必须先登记{label}",
                code=ErrorCode.DELIVERY_CONDITION_UNMET,
                details={"delivery_direction": direction, "required_event": required_event},
            )
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
        is_posted=True,
        posted_at=now_second(),
        note=note,
        form_extra={
            **(dict(form_extra) if form_extra else {}),
            "delivery_direction": direction,
            **({"bound_phone": normalized_bound_phone} if normalized_bound_phone is not None else {}),
            **({"bound_phone_owner": normalized_bound_phone_owner} if normalized_bound_phone_owner is not None else {}),
        } or None,
        created_by=actor,
        updated_by=actor,
    )
    session.add(event)
    if normalized_bound_phone is not None or normalized_bound_phone_owner is not None:
        # 订单详情的买号／卖号交付字段各自独立；只覆盖本次交付实际填写的值。
        order_extra = dict(order.form_extra or {})
        prefix = "sell_" if direction == "SELL" else ""
        if normalized_bound_phone is not None:
            order_extra[f"{prefix}bound_phone"] = normalized_bound_phone
        if normalized_bound_phone_owner is not None:
            order_extra[f"{prefix}bound_phone_owner"] = normalized_bound_phone_owner
        order.form_extra = order_extra
        order.updated_by = actor
        account = session.get(Account, order.account_id) if order.account_id is not None else None
        snapshot = dict(order.account_snapshot or {})
        if not snapshot.get("game_account") and account is not None and account.game_account:
            snapshot.update({
                "game_account": account.game_account,
                "game_type": account.game_type,
                "game_password": account.game_password,
                "channel_region": account.channel_region,
                "has_secondary": account.has_secondary,
                "note": account.note,
            })
        if normalized_bound_phone is not None:
            snapshot["bound_phone"] = normalized_bound_phone
        if normalized_bound_phone_owner is not None:
            snapshot["bound_phone_owner"] = normalized_bound_phone_owner
        if snapshot.get("game_account"):
            order.account_snapshot = snapshot
    if order.account_id is not None and direction == "SELL":
        account = session.get(Account, order.account_id)
        if account is not None:
            if normalized_bound_phone is not None:
                account.bound_phone = normalized_bound_phone
            if account.status == AccountStatus.VOID.value:
                raise Validation(
                    f"账号 {account.stock_no} 已作废，不能登记卖号交付",
                    details={"account_id": account.id, "status": account.status},
                )
            if account.status != AccountStatus.SOLD.value:
                # 正常路径 SELL 事件已把账号置为 SOLD；这里仅为异常数据兜底，
                # 且必须走状态机，禁止直接赋值复活 VOID 终态账号。
                account.status = transition(
                    ACCOUNT_TRANSITIONS, account.status, "SELL", entity="账号"
                )
            account.updated_by = actor
    if direction == "SELL" and order.status != OrderStatus.COMPLETED.value:
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
        after={"order_no": order.order_no},
    )
    return event, None


def _resolve_pool(
    session: Session,
    order: Order,
    portion: str,
) -> Pool:
    """落账资金账户：零本金业务拒绝本金支出，其余一律进唯一活动池。

    2026-11-17 删除业务↔池路由后，池不再由（业务 + 份额）决定；
    零本金改为业务类型自身的标记（`order_type_defs.is_zero_principal`）。
    """
    definition = get_order_type_by_code(session, order.order_type)
    if (
        definition is not None
        and definition.is_zero_principal
        and portion == "PRINCIPAL"
    ):
        raise Validation(
            f"业务 {order.order_type}（{definition.name}）为零本金型，不能登记本金支出",
            code=ErrorCode.ZERO_PRINCIPAL_FORBIDDEN,
            details={"order_type": order.order_type, "portion": portion},
        )
    return require_default_pool(session)


def _assert_pool_active(session: Session, pool_id: int) -> Pool:
    """停用池不得用于新记录（QLT-01-04：主数据一致性校验）。"""
    pool = session.get(Pool, pool_id)
    if pool is None:
        raise NotFound(f"资金账户 {pool_id} 不存在", details={"pool_id": pool_id})
    if pool.status != PoolStatus.ACTIVE.value:
        raise Validation(
            f"资金账户 {pool.code} 已停用，不能登记新流水",
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
    if event_type == EventType.BUY.value:
        account.cost_amount = to_money(account.cost_amount) + amount
        account.buy_date = order.trade_date
        # 买号统一使用 BUY_STOCK；全款/分期由 SELL 的 SALE_MODE 属性区分，
        # 不再把“信用买入”伪装成账号状态动作。
        target = ACCOUNT_TRANSITIONS.get(account.status, {}).get("BUY_STOCK")
        if target is not None:
            account.status = target
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
    "_post_deliver",
    "_resolve_pool",
]
