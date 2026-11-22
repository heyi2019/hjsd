"""orders.router_outputs._shared：订单/事件输出共用的装配与金额原语。"""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.money import to_money, to_money_or_zero
from app.domain.trade import OrderEvent
from app.domain.users import User
from app.business.orders import schemas
from app.shared.order_amounts import ZERO
from app.business.orders.output_labels import _selected_operator_label


def _apply_common_output(output, order):
    """回显订单表单扩展值与账号快照。"""
    # 表单字段自定义值落订单 form_extra 列，读取直接回显（BAS-04-03 历史值可查）。
    output.extra_values = dict(order.form_extra or {})
    return output


def _order_output(order) -> schemas.OrderOut:
    """输出订单详情。"""
    output = schemas.OrderOut.model_validate(order)
    return _apply_common_output(output, order)


def _operator_names(db: Session, events: list[OrderEvent]) -> dict[int, str]:
    ids = {user_id for event in events for user_id in (event.operator_user_ids or [])}
    if not ids:
        return {}
    users = db.scalars(select(User).where(User.id.in_(ids))).all()
    return {user.id: user.display_name or user.username for user in users}


def _sale_amount(order_type: str, events: list[OrderEvent]) -> Decimal | None:
    """列表展示的售出金额：只取 SELL，不把 BUY 成本合进来。"""
    sell_events = [event for event in events if event.event_type == "SELL"]
    if not sell_events:
        return None
    # 回收/提号可取消售出后重新售出；补录日期可能早于前次，按事件编号识别本次。
    # 历史资金流水仍单独参与利润计算。
    if order_type in ("HS", "TH"):
        return to_money(max(sell_events, key=lambda event: event.id).amount)
    if order_type == "DG":
        recorded = [
            to_money_or_zero((event.form_extra or {}).get("sale_amount"))
            for event in sell_events
            if (event.form_extra or {}).get("sale_amount") not in (None, "")
        ]
        if recorded:
            return sum(recorded, ZERO)
    return sum((to_money(event.amount) for event in sell_events), ZERO)


def cancellable_by_event(events: list[OrderEvent]) -> dict[int, Decimal]:
    """每个事件的可冲销余额：`amount − Σ已冲销 CANCEL`，夹底 0；CANCEL 自身恒 0。

    与 `post_event` 的冲销校验同源（校验挡住超额，这里给前端展示「还能冲多少」）。
    一次遍历累加 CANCEL 再逐事件相减，避免每个事件回查一遍。
    """
    cancelled: dict[int, Decimal] = {}
    for item in events:
        if item.event_type == "CANCEL" and item.offset_event_id is not None:
            cancelled[item.offset_event_id] = cancelled.get(item.offset_event_id, Decimal("0.00")) + to_money(item.amount)
    amounts: dict[int, Decimal] = {}
    for item in events:
        if item.event_type == "CANCEL" or item.source_type == "INSTALLMENT_RECOVERY":
            amounts[item.id] = Decimal("0.00")
            continue
        remaining = to_money(item.amount) - cancelled.get(item.id, Decimal("0.00"))
        amounts[item.id] = remaining if remaining > 0 else Decimal("0.00")
    return amounts


def _event_output(
    event: OrderEvent,
    operator_names: dict[int, str] | None = None,
    cancellable: dict[int, Decimal] | None = None,
) -> schemas.EventOut:
    """把审计字段映射为事件响应字段，避免 ORM 属性名泄漏到 API。"""
    selected_operators = _selected_operator_label(event, operator_names)
    return schemas.EventOut.model_validate(
        {
            "id": event.id,
            "event_no": event.event_no,
            "order_id": event.order_id,
            "event_type": event.event_type,
            "sale_mode": (event.form_extra or {}).get("sale_mode"),
            "operation_type": (event.form_extra or {}).get("operation_type"),
            "rebate_type": (event.form_extra or {}).get("rebate_type"),
            "amount": event.amount,
            "occurred_on": event.occurred_on,
            "pool_id": event.pool_id,
            "offset_event_id": event.offset_event_id,
            "portion": event.portion,
            "delivery_direction": (event.form_extra or {}).get("delivery_direction"),
            "is_posted": event.is_posted,
            "posted_at": event.posted_at,
            "reason": event.reason,
            "operator_user_ids": event.operator_user_ids,
            "note": event.note,
            "form_extra": event.form_extra,
            "created_at": event.created_at,
            # created_by 是审计操作者；业务上的操作人以表单勾选员工为准。
            "operator": selected_operators or "-",
            "cancellable_amount": (cancellable or {}).get(event.id, Decimal("0.00")),
        }
    )
