"""订单寄售运营动作（ORD-CONSIGN）。

寄售属于原订单上的运营动作，不负责建单、建库存或资金处理。
本模块对外只暴露三个业务入口：寄售上架、平台下架、系统下架；
底层事件事务统一复用 ``orders.events``。
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.core.security import CurrentUser
from app.domain.enums import EventType, OperationType
from app.domain.trade import Cashflow, Order, OrderEvent

from app.shared.order_access import get_order
from ...orders.events import post_event as _post_event
from ..listing_state import active_listings


def _post_operation(
    session: Session,
    order_id: int,
    *,
    operation_type: OperationType,
    occurred_on: date,
    actor: str,
    note: str | None,
    operator_user_ids: list[int] | None,
    form_extra: Mapping[str, Any] | None,
    form_extra_scope: str | None,
    user: CurrentUser | None,
    reason: str | None = None,
) -> tuple[OrderEvent, Cashflow | None]:
    """寄售运营事件的唯一落库适配器。"""
    return _post_event(
        session,
        order_id,
        event_type=EventType.OPERATE.value,
        operation_type=operation_type.value,
        occurred_on=occurred_on,
        actor=actor,
        note=note,
        reason=reason,
        operator_user_ids=operator_user_ids,
        form_extra=form_extra,
        form_extra_scope=form_extra_scope,
        user=user,
    )


def _with_unlist_scope(
    form_extra: Mapping[str, Any] | None,
    scope: str,
) -> dict[str, Any]:
    extra = dict(form_extra or {})
    current_scope = str(extra.get("platform_unlist_scope") or "").strip().upper()
    if current_scope and current_scope != scope:
        raise Validation(
            f"寄售下架范围必须为 {scope}",
            details={"field": "platform_unlist_scope", "value": current_scope},
        )
    extra["platform_unlist_scope"] = scope
    return extra


def register_consignment(
    session: Session,
    order_id: int,
    *,
    occurred_on: date,
    actor: str,
    note: str | None = None,
    operator_user_ids: list[int] | None = None,
    form_extra: Mapping[str, Any] | None = None,
    form_extra_scope: str | None = "CONSIGN",
    user: CurrentUser | None = None,
) -> tuple[OrderEvent, Cashflow | None]:
    """寄售上架：只在原订单登记 CONSIGNMENT 运营事件。"""
    return _post_operation(
        session,
        order_id,
        operation_type=OperationType.CONSIGNMENT,
        occurred_on=occurred_on,
        actor=actor,
        note=note,
        operator_user_ids=operator_user_ids,
        form_extra=form_extra,
        form_extra_scope=form_extra_scope,
        user=user,
    )


def platform_unlist_consignment(
    session: Session,
    order_id: int,
    *,
    occurred_on: date,
    actor: str,
    note: str | None = None,
    operator_user_ids: list[int] | None = None,
    form_extra: Mapping[str, Any] | None = None,
    form_extra_scope: str | None = "INVOID",
    user: CurrentUser | None = None,
    reason: str | None = None,
) -> tuple[OrderEvent, Cashflow | None]:
    """平台下架：只登记 UNLIST，账号仍保留在 ERP 库存。"""
    order = get_order(session, order_id, user)
    session.execute(select(Order.id).where(Order.id == order.id).with_for_update()).scalar_one()
    extra = _with_unlist_scope(form_extra, "PLATFORM")
    listing_id = extra.get("consignment_event_id")
    platforms = extra.get("consignment_platforms")
    if not isinstance(listing_id, int) or isinstance(listing_id, bool) or not isinstance(platforms, list) or len(platforms) != 1 or not isinstance(platforms[0], str) or (listing_id, platforms[0].strip()) not in active_listings(session, order.id):
        raise Validation("请选择当前订单仍在上架的具体平台记录")
    extra["consignment_platforms"] = [platforms[0].strip()]
    return _post_operation(
        session,
        order_id,
        operation_type=OperationType.UNLIST,
        occurred_on=occurred_on,
        actor=actor,
        note=note,
        reason=reason,
        operator_user_ids=operator_user_ids,
        form_extra=extra,
        form_extra_scope=form_extra_scope,
        user=user,
    )


def system_unlist_consignment(
    session: Session,
    order_id: int,
    *,
    occurred_on: date,
    actor: str,
    note: str | None = None,
    operator_user_ids: list[int] | None = None,
    form_extra: Mapping[str, Any] | None = None,
    form_extra_scope: str | None = "INVOID",
    user: CurrentUser | None = None,
) -> tuple[OrderEvent, Cashflow | None]:
    """系统下架：仅 DG 可用；登记 UNLIST 后由调用方取消/冲销并退出库存。"""
    order = get_order(session, order_id, user)
    if order.order_type != "DG":
        raise Validation("只有 DG 代挂订单允许系统下架")
    return _post_operation(
        session,
        order_id,
        operation_type=OperationType.UNLIST,
        occurred_on=occurred_on,
        actor=actor,
        note=note,
        operator_user_ids=operator_user_ids,
        form_extra=_with_unlist_scope(form_extra, "SYSTEM"),
        form_extra_scope=form_extra_scope,
        user=user,
    )


def post_consignment_operation(
    session: Session,
    order_id: int,
    *,
    operation_type: str,
    occurred_on: date,
    actor: str,
    note: str | None = None,
    operator_user_ids: list[int] | None = None,
    form_extra: Mapping[str, Any] | None = None,
    form_extra_scope: str | None = None,
    user: CurrentUser | None = None,
    reason: str | None = None,
) -> tuple[OrderEvent, Cashflow | None]:
    """HTTP 事件入口适配器：把寄售请求路由到三个明确业务入口。"""
    normalized = operation_type.strip().upper()
    if normalized == OperationType.CONSIGNMENT.value:
        return register_consignment(
            session,
            order_id,
            occurred_on=occurred_on,
            actor=actor,
            note=note,
            operator_user_ids=operator_user_ids,
            form_extra=form_extra,
            form_extra_scope=form_extra_scope or "CONSIGN",
            user=user,
        )
    if normalized == OperationType.UNLIST.value:
        scope = str((form_extra or {}).get("platform_unlist_scope") or "").strip().upper()
        if scope == "PLATFORM":
            return platform_unlist_consignment(
                session,
                order_id,
                occurred_on=occurred_on,
                actor=actor,
                note=note,
                reason=reason,
                operator_user_ids=operator_user_ids,
                form_extra=form_extra,
                form_extra_scope=form_extra_scope or "INVOID",
                user=user,
            )
        if scope == "SYSTEM":
            return system_unlist_consignment(
                session,
                order_id,
                occurred_on=occurred_on,
                actor=actor,
                note=note,
                operator_user_ids=operator_user_ids,
                form_extra=form_extra,
                form_extra_scope=form_extra_scope or "INVOID",
                user=user,
            )
        raise Validation(
            "寄售下架必须明确为平台下架或系统下架",
            details={"field": "platform_unlist_scope", "value": scope or None},
        )
    raise Validation(
        "寄售运营动作必须为 CONSIGNMENT 或 UNLIST",
        details={"field": "operation_type", "value": operation_type},
    )
