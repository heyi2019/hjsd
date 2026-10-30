"""finance 返点服务（REB-01）。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.business_numbering import rebate_no as order_rebate_no
from app.core.errors import ErrorCode, NotFound, Validation
from app.core.money import to_money
from app.core.security import CurrentUser, owner_scope_filter
from app.domain.enums import (
    AuditAction,
    OrderStatus,
    PolicyType,
    RebateStatus,
    RebateType,
)
from app.domain.trade import RebateRecord
from app.domain.users import User
from app.foundation import service as foundation_service
from app.orders import service as orders_service
from app.orders.form_fields import validate_form_extra
from app.orders.amounts import order_amounts
from app.policy import service as policy_service

from ._common import _non_negative, _positive

# --------------------------------------------------------------------- 返点
def create_rebate(
    session: Session,
    *,
    source_order_id: int,
    base_amount: Any = None,
    collected_on: date,
    actor: str,
    rebate_type: str | None = None,
    rate: Any = None,
    channel: str | None = None,
    note: str | None = None,
    operator_user_ids: list[int] | None = None,
    form_extra: dict[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> RebateRecord:
    """返点记录：来源订单必填且必须已成单（REB-01-02）。

    base_amount 省略时按 REBATE 规则的 config.base 从订单事件派生（与报表同口径）。
    """
    try:
        order = orders_service.get_order(session, source_order_id, user)
    except NotFound as exc:
        if user is not None:
            raise
        raise Validation(
            f"来源订单 {source_order_id} 不存在",
            code=ErrorCode.RESOURCE_NOT_FOUND,
            details={"source_order_id": source_order_id},
        ) from exc
    if order.status not in (OrderStatus.ACTIVE.value, OrderStatus.COMPLETED.value):
        raise Validation(
            f"来源订单 {order.order_no} 状态 {order.status}，不可作为返点来源",
            code=ErrorCode.ORDER_STATUS_CONFLICT,
            details={"order_no": order.order_no, "status": order.status},
        )
    if rebate_type not in RebateType.values():
        raise Validation(
            f"返点类型必须为 {RebateType.values()}",
            details={"field": "rebate_type", "value": rebate_type},
        )
    if rebate_type == RebateType.BUY.value and order.order_type not in ("HS", "TH", "DFQ"):
        raise Validation(
            "买号返点只能关联回收、提号或代分期订单",
            details={"rebate_type": rebate_type, "order_type": order.order_type},
        )
    # 返点资格由业务订单是否已创建决定；BUY/SELL/PAYMENT 仅作为后续业务流水，
    # 不能阻止在订单创建后先登记预计返点。

    rebate_no = order_rebate_no(session, order_no=order.order_no, order_id=order.id)
    # BAS-06-04：按返点日期固化规则版本，改版不影响历史记录
    order_type_definition = foundation_service.get_order_type_by_code(
        session, order.order_type
    )
    policy_version_id, snapshot = policy_service.make_snapshot(
        session,
        policy_code=PolicyType.REBATE.value,
        on=collected_on,
        scope_type="ORDER_TYPE",
        scope_id=order_type_definition.id if order_type_definition else None,
    )
    # 基数：显式传参优先；未传时按规则 config.base 从订单事件派生（与报表同口径）。
    resolved_base = base_amount
    if resolved_base is None:
        resolved_base = _rebate_base_from_snapshot(session, snapshot, order)
    base = _positive(resolved_base, field="base_amount")
    if rate is None:
        rate = _rebate_rate_from_snapshot(snapshot, rebate_type)
    rebate_rate = _non_negative(Decimal("0") if rate is None else rate, field="rate")
    if rebate_rate > Decimal("100.00"):
        raise Validation(
            "返点比例必须在 0% 到 100% 之间",
            details={"field": "rate", "value": str(rebate_rate)},
        )
    operator_ids = _validate_operator_user_ids(session, operator_user_ids)
    record = RebateRecord(
        rebate_no=rebate_no,
        source_order_id=order.id,
        rebate_type=rebate_type,
        channel=channel,
        rate=rebate_rate,
        base_amount=base,
        collected_on=collected_on,
        policy_version_id=policy_version_id,
        policy_snapshot=snapshot,
        # 返点登记即完成收入确认，不再走后续结算/冲销状态机。
        status=RebateStatus.SETTLED.value,
        note=note,
        operator_user_ids=operator_ids,
        form_extra=validate_form_extra(session, order_type_code="INVREBATE", values=form_extra) or None,
        created_by=actor,
        updated_by=actor,
    )
    session.add(record)
    session.flush()
    record_audit(
        session,
        action=AuditAction.REBATE_CREATE,
        entity_type="rebate_record",
        entity_id=record.rebate_no,
        actor=actor,
        after={"source_order": order.order_no, "base_amount": str(base)},
    )
    return record


def _validate_operator_user_ids(session: Session, operator_user_ids: list[int] | None) -> list[int] | None:
    if operator_user_ids is None:
        return None
    if len(set(operator_user_ids)) != len(operator_user_ids):
        raise Validation("操作人不能重复选择", details={"field": "operator_user_ids"})
    active_ids = set(session.scalars(select(User.id).where(User.id.in_(operator_user_ids), User.is_active.is_(True))))
    if active_ids != set(operator_user_ids):
        raise Validation("所选操作人不存在或已停用", details={"field": "operator_user_ids"})
    return operator_user_ids


def _rebate_base_from_snapshot(
    session: Session, snapshot: dict[str, Any] | None, order: Any
) -> Decimal | None:
    """按 REBATE 规则的 config.base 派生返点基数。

    口径复用 app/orders/amounts.py（与报表同源）：
    - GROSS：卖出收入合计（成交额）
    - PRINCIPAL：买入成本合计（本金）
    - PROFIT：收入 - 买入成本 - 直接费用

    规则未声明 base 时返回 None，由调用方按「base_amount 必填」报错，不静默兜底。
    """
    if not snapshot:
        return None
    config = snapshot.get("config")
    if not isinstance(config, dict):
        return None
    kind = config.get("base")
    if not isinstance(kind, str) or not kind.strip():
        return None
    return order_amounts(session, order.id).get(kind.strip().upper())


def _rebate_rate_from_snapshot(
    snapshot: dict[str, Any] | None, rebate_type: str
) -> Decimal | None:
    """从 REBATE 规则快照读取费率；显式传入的 rate 始终优先。"""
    if not snapshot:
        return None
    config = snapshot.get("config")
    if not isinstance(config, dict):
        return None
    rates = config.get("rates")
    value: Any = rates.get(rebate_type) if isinstance(rates, dict) else None
    if value is None:
        value = config.get("rate")
    if value is None:
        return None
    try:
        return to_money(value)
    except (TypeError, ValueError, ArithmeticError) as exc:
        raise Validation(
            "返点规则中的费率必须是数值",
            details={"field": "config.rate", "value": value},
        ) from exc


def list_rebates(
    session: Session,
    *,
    source_order_id: int | None = None,
    user: CurrentUser | None = None,
) -> list[RebateRecord]:
    from app.domain.trade import Order

    stmt = select(RebateRecord)
    if source_order_id is not None:
        stmt = stmt.where(RebateRecord.source_order_id == source_order_id)
    scope = owner_scope_filter(Order.owner_id, user, session) if user is not None else None
    if scope is not None:
        stmt = stmt.join(Order, Order.id == RebateRecord.source_order_id).where(scope)
    return list(session.scalars(stmt.order_by(RebateRecord.id)).all())


def get_rebate(
    session: Session,
    rebate_id: int,
    *,
    user: CurrentUser | None = None,
) -> RebateRecord:
    record = session.get(RebateRecord, rebate_id)
    if record is None:
        raise NotFound("返点记录不存在", details={"rebate_record_id": rebate_id})
    if user is not None:
        from app.domain.trade import Order

        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            visible = session.scalar(
                select(RebateRecord.id)
                .join(Order, Order.id == RebateRecord.source_order_id)
                .where(RebateRecord.id == rebate_id, scope)
            )
            if visible is None:
                raise NotFound("返点记录不存在", details={"rebate_record_id": rebate_id})
    return record


def update_rebate(
    session: Session,
    rebate_id: int,
    *,
    actor: str,
    base_amount: Any = None,
    rate: Any = None,
    collected_on: date | None = None,
    note: str | None = None,
    operator_user_ids: list[int] | None = None,
    form_extra: dict[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> RebateRecord:
    record = get_rebate(session, rebate_id, user=user)
    before = {"base_amount": str(record.base_amount), "rate": str(record.rate), "collected_on": str(record.collected_on), "note": record.note}
    if base_amount is not None:
        record.base_amount = _positive(base_amount, field="base_amount")
    if rate is not None:
        record.rate = _non_negative(rate, field="rate")
        if record.rate > Decimal("100.00"):
            raise Validation("返点比例必须在 0% 到 100% 之间", details={"field": "rate"})
    if collected_on is not None:
        record.collected_on = collected_on
    if note is not None:
        record.note = note
    if operator_user_ids is not None:
        record.operator_user_ids = _validate_operator_user_ids(session, operator_user_ids)
    if form_extra is not None:
        record.form_extra = validate_form_extra(session, order_type_code="INVREBATE", values=form_extra) or None
    record.updated_by = actor
    session.flush()
    record_audit(session, action=AuditAction.REBATE_UPDATE, entity_type="rebate_record", entity_id=record.rebate_no, actor=actor, before=before, after={"base_amount": str(record.base_amount), "rate": str(record.rate), "collected_on": str(record.collected_on), "note": record.note})
    return record


def delete_rebate(session: Session, rebate_id: int, *, actor: str, user: CurrentUser | None = None) -> None:
    record = get_rebate(session, rebate_id, user=user)
    rebate_no = record.rebate_no
    status = record.status
    session.delete(record)
    session.flush()
    record_audit(session, action=AuditAction.REBATE_DELETE, entity_type="rebate_record", entity_id=rebate_no, actor=actor, before={"rebate_no": rebate_no, "status": status})

__all__ = [
    "create_rebate",
    "delete_rebate",
    "get_rebate",
    "list_rebates",
    "update_rebate",
]

