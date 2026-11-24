"""orders 事件登记的私有 helper（ORD-02）。

从 ``events.post_event`` 拆出的内聚逻辑块：入参规范化、上下文守卫、资金/冲销
解析与表单快照构建。母文件 ``events.py`` 保留 ``post_event`` 作为唯一整合调用
入口，本模块不对外暴露公共 API。
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.core.security import CurrentUser
from app.domain.cashflow_attributes import accounting_attribute_for_order_event
from app.domain.enums import (
    Direction,
    EventType,
    OperationType,
    OrderStatus,
    Portion,
    RebateType,
    SaleMode,
)
from app.domain.trade import Account, Installment, Order, OrderEvent
from app.settings.field_definitions.order_types import get_order_type_by_code
from app.settings.field_definitions.pools import require_default_pool
from app.shared.operation_operators import validate_optional_operator_ids
from app.shared.form_field_rules import validate_form_extra

from ..shared.validation import _required_bool
from ..shared.cancellation_model import (
    get_cancellation_offset as _get_offset_event,
    opposite_cancellation_direction as _opposite_direction,
)
from .events_rules import _assert_pool_active
from ..shared.delivery_fields import DELIVERY_FIELDS

def _auto_link_recovered_installment_sale(
    session: Session,
    order: Order,
    *,
    occurred_on: date,
    actor: str,
    note: str | None,
) -> None:
    """库存中心完成出售后，自动关联该账号最近一次未转售的回收处置。

    实际联动逻辑由 installments 域经 collaboration 注册点注入
    （orders 不得反向依赖 installments，见 backend/.importlinter）。
    """
    from ..collaboration import run_post_sell_hooks

    run_post_sell_hooks(
        session,
        order,
        occurred_on=occurred_on,
        actor=actor,
        note=note,
    )


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
    # 操作人校验委托共享原语（None 跳过、重复/停用拒绝），消除与资金/返点域的副本。
    validate_optional_operator_ids(session, operator_user_ids)
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
            select(Installment.id).where(Installment.order_id == order.id, Installment.status != "CANCELLED")
        )
        is None
    )
    can_validate_completed_sell = (
        event_type == EventType.SELL.value
        and order.status == OrderStatus.COMPLETED.value
        and session.scalar(
            select(Installment.id).where(Installment.order_id == order.id, Installment.status != "CANCELLED")
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


def _resolve_event_funding_context(
    session: Session,
    order: Order,
    *,
    event_type: str,
    offset_event_id: int | None,
    pool_id: int | None,
    money: Any,
    has_cashflow: bool,
    portion: str,
    user: CurrentUser | None,
) -> tuple[Any | None, bool, str | None, int | None, str]:
    """冲销解析 + 资金池/会计属性路由 + 冲销方向：只读校验与派生，口径与原内联版本一致。

    返回 (offset, cancel_fully_consumed, accounting_attribute,
    resolved_pool_id, cancel_direction)，供后续事件落库与现金流派生复用。
    """
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
        if event_type == EventType.BUY.value and portion == Portion.PRINCIPAL.value:
            definition = get_order_type_by_code(session, order.order_type)
            if definition is not None and definition.is_zero_principal:
                raise Validation(
                    f"业务 {order.order_type}（{definition.name}）为零本金型，不能登记本金支出",
                    code=ErrorCode.ZERO_PRINCIPAL_FORBIDDEN,
                    details={"order_type": order.order_type, "portion": portion},
                )
        accounting_attribute = accounting_attribute_for_order_event(
            order.order_type, event_type
        )
        resolved_pool_id = (
            pool_id
            or (offset.pool_id if offset is not None else None)
            or require_default_pool(session).id
        )
        if user is not None and not user.can_see_pool(resolved_pool_id):
            raise NotFound("资金账户不存在", details={"pool_id": resolved_pool_id})
        _assert_pool_active(session, resolved_pool_id)
    cancel_direction = Direction.IN.value
    if event_type == EventType.CANCEL.value:
        cancel_direction = _opposite_direction(offset_event_id, session, order_id=order.id)
    return (
        offset,
        cancel_fully_consumed,
        accounting_attribute,
        resolved_pool_id,
        cancel_direction,
    )


def _build_event_form_extra(
    session: Session,
    order: Order,
    *,
    event_type: str,
    sale_mode: str | None,
    operation_type: str | None,
    rebate_type: str | None,
    bound_phone: str | None,
    bound_phone_owner: str | None,
    form_extra: Mapping[str, Any] | None,
    form_extra_scope: str | None,
    form_extra_context: Mapping[str, Any] | None,
    actor: str,
) -> dict[str, Any]:
    """规范化绑定手机、校验扩展字段，并在 SELL 时写入账号/订单快照。

    对 order / account 的写入通过 ORM 引用保留，副作用与判定口径与原内联版本一致。
    """
    normalized_bound_phone = bound_phone.strip() if isinstance(bound_phone, str) and bound_phone.strip() else None
    normalized_bound_phone_owner = bound_phone_owner.strip() if isinstance(bound_phone_owner, str) and bound_phone_owner.strip() else None
    sale_scope = {"HS": "SALEREC", "TH": "SALETH", "DG": "SALEDG"}.get(order.order_type)
    scope = sale_scope if event_type == EventType.SELL.value and sale_scope else form_extra_scope
    event_form_extra = (
        validate_form_extra(
            session, order_type_code=scope, values=form_extra,
            context={**(form_extra_context or {}),
                     **({"payment_method": sale_mode} if event_type == EventType.SELL.value else {})},
        )
        if scope else dict(form_extra or {})
    )
    if event_type == EventType.SELL.value and sale_mode is not None:
        event_form_extra["sale_mode"] = sale_mode
    if operation_type is not None:
        event_form_extra["operation_type"] = operation_type
    if rebate_type is not None:
        event_form_extra["rebate_type"] = rebate_type
    if event_type == EventType.SELL.value:
        account = session.get(Account, order.account_id) if order.account_id is not None else None
        snapshot = dict(order.account_snapshot or {})
        order_extra = dict(order.form_extra or {})
        if "bound_phone" not in order_extra:
            order_extra["bound_phone"] = snapshot.get("bound_phone", account.bound_phone if account else None)
        sale_delivery = {f"sell_{key}": (form_extra_context or {}).get(key) for key in DELIVERY_FIELDS}
        sale_delivery["sell_bound_phone"] = normalized_bound_phone
        sale_delivery["sell_bound_phone_owner"] = normalized_bound_phone_owner
        order_extra.update(sale_delivery)
        order.form_extra = order_extra
    if event_type == EventType.SELL.value and (normalized_bound_phone is not None or normalized_bound_phone_owner is not None):
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
    return event_form_extra
