"""orders.mutations：订单更新与取消（ORD-02）。

状态流转走 `ORDER_TRANSITIONS`，取消不物理删除，保留事件与审计。
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any
from app.core.audit import record_audit
from app.core.security import CurrentUser
from app.orders.form_fields import validate_form_extra
from app.parties import service as parties_service
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import Validation
from app.domain.trade import (
    Order,
    OrderEvent,
)
from app.domain.enums import (
    AuditAction,
)

from .cancellation_model import cancel_order
from ._shared import (
    _audit_value,
    get_order,
)

_UNSET = object()

def update_order(
    session: Session,
    order_id: int,
    *,
    actor: str,
    trade_date: date | None | object = _UNSET,
    account_snapshot: dict[str, Any] | None | object = _UNSET,
    note: str | None | object = _UNSET,
    extra_values: Mapping[str, Any] | None | object = _UNSET,
    form_extra: Mapping[str, Any] | None | object = _UNSET,
    user: CurrentUser | None = None,
) -> Order:
    """受控编辑订单主字段。

    订单一旦存在已登记事件，核算字段只能通过事件冲销/更正处理；备注仍可补充。
    订单编号、业务类型、库存账号关联和状态属于不可编辑的身份字段。
    """
    order = get_order(session, order_id, user)
    if trade_date is not _UNSET and trade_date is None:
        raise Validation("订单日期不能清空", details={"field": "trade_date"})
    accounting_changes = (
        trade_date,
        account_snapshot,
    )
    if any(value is not _UNSET for value in accounting_changes):
        posted = session.scalar(
            select(OrderEvent.id).where(
                OrderEvent.order_id == order.id,
                OrderEvent.is_posted.is_(True),
            )
        )
        if posted is not None:
            raise Validation("已有登记事件的订单只能修改备注，核算字段必须通过冲销/更正")

    if account_snapshot is not _UNSET and account_snapshot is not None:
        raise Validation("订单账号快照当前不支持")

    before = {
        "trade_date": order.trade_date,
        "account_snapshot": order.account_snapshot,
        "note": order.note,
    }
    if trade_date is not _UNSET:
        order.trade_date = trade_date
    if account_snapshot is not _UNSET:
        order.account_snapshot = account_snapshot
    if note is not _UNSET:
        order.note = note
    order.updated_by = actor
    session.flush()
    if extra_values is not _UNSET:
        parties_service.set_extra_values(
            session,
            entity_type="order",
            entity_id=order.id,
            values=(extra_values or {}).items(),
        )
    if form_extra is not _UNSET and form_extra:
        # ORDEREDIT 作用域自定义字段值合并进订单 form_extra。
        checked = validate_form_extra(session, order_type_code="ORDEREDIT", values=form_extra)
        order.form_extra = {**(order.form_extra or {}), **checked}
    record_audit(
        session,
        action=AuditAction.ORDER_UPDATE,
        entity_type="order",
        entity_id=order.order_no,
        actor=actor,
        before=_audit_value(before),
        after=_audit_value({
            "trade_date": order.trade_date,
            "account_snapshot": order.account_snapshot,
            "note": order.note,
        }),
    )
    return order
