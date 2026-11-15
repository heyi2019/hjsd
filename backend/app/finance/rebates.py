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
    Direction,
    FundNature,
    Nature,
    OrderStatus,
    Portion,
    RebateStatus,
    RebateType,
)
from app.domain.trade import Cashflow, OrderEvent, RebateRecord
from app.domain.users import User
from app.foundation.order_types import resolve_default_pool
from app.orders._shared import get_order
from app.orders.events import post_event
from app.orders.form_fields import validate_form_extra
from ._common import _positive

# --------------------------------------------------------------------- 返点
def create_rebate(
    session: Session,
    *,
    source_order_id: int,
    amount: Any,
    collected_on: date,
    actor: str,
    rebate_type: str | None = None,
    channel: str | None = None,
    note: str | None = None,
    operator_user_ids: list[int] | None = None,
    form_extra: dict[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> RebateRecord:
    """返点记录：来源订单必填且必须已成单（REB-01-02）。

    返点金额由登记人明确提供。
    """
    try:
        order = get_order(session, source_order_id, user)
    except NotFound as exc:
        if user is not None:
            raise
        raise Validation(
            f"来源订单 {source_order_id} 不存在",
            code=ErrorCode.RESOURCE_NOT_FOUND,
            details={"source_order_id": source_order_id},
        ) from exc
    if order.status not in (
        OrderStatus.ACTIVE.value,
        OrderStatus.INSTALLMENT.value,
        OrderStatus.COMPLETED.value,
    ):
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
    if rebate_type == RebateType.BUY.value and order.order_type not in ("HS", "TH"):
        raise Validation(
            "买号返点只能关联回收、提号订单",
            details={"rebate_type": rebate_type, "order_type": order.order_type},
        )
    # 返点资格由业务订单是否已创建决定；BUY/SELL 仅作为后续业务事实，
    # 不能阻止在订单创建后先登记预计返点。

    rebate_no = order_rebate_no(session, order_no=order.order_no, order_id=order.id)
    amount = _positive(amount, field="amount")
    operator_ids = _validate_operator_user_ids(session, operator_user_ids)
    record = RebateRecord(
        rebate_no=rebate_no,
        source_order_id=order.id,
        rebate_type=rebate_type,
        channel=channel,
        amount=amount,
        collected_on=collected_on,
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
    # 返点是业务动作，同时形成一笔收入资金明细；两者共享订单与发生日，
    # 资金明细通过 order_event_id 回指动作，避免返点只停留在附属表里。
    event, _ = post_event(
        session,
        order.id,
        event_type="REBATE",
        amount=amount,
        occurred_on=collected_on,
        actor=actor,
        rebate_type=rebate_type,
        note=note,
        form_extra_scope="INVREBATE",
        form_extra=form_extra,
        user=user,
    )
    event_extra = dict(event.form_extra or {})
    event_extra["rebate_record_id"] = record.id
    event.form_extra = event_extra
    pool = resolve_default_pool(
        session,
        order.order_type,
        Portion.PROFIT.value,
        fund_nature=FundNature.BUSINESS.value,
    )
    if pool is None:
        raise Validation(
            f"业务 {order.order_type} 未配置 {Portion.PROFIT.value} 资金池",
            code=ErrorCode.POOL_ROUTE_MISSING,
            details={"order_type": order.order_type, "portion": Portion.PROFIT.value},
        )
    from app.finance.cashflows import create_cashflow

    flow = create_cashflow(
        session,
        pool_id=pool.id,
        occurred_on=collected_on,
        direction=Direction.IN.value,
        nature=Nature.BUSINESS_IN.value,
        category="REBATE",
        amount=amount,
        actor=actor,
        order_id=order.id,
        order_event_id=event.id,
        note=note or f"{rebate_type} 返点",
        form_extra={**(form_extra or {}), "rebate_record_id": record.id},
        form_extra_scope="INVREBATE",
        user=user,
    )
    record_audit(
        session,
        action=AuditAction.REBATE_CREATE,
        entity_type="rebate_record",
        entity_id=record.rebate_no,
        actor=actor,
        after={
            "source_order": order.order_no,
            "amount": str(amount),
            "event_no": event.event_no,
            "flow_no": flow.flow_no,
        },
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
    amount: Any = None,
    collected_on: date | None = None,
    note: str | None = None,
    operator_user_ids: list[int] | None = None,
    form_extra: dict[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> RebateRecord:
    record = get_rebate(session, rebate_id, user=user)
    before = {"amount": str(record.amount), "collected_on": str(record.collected_on), "note": record.note}
    if amount is not None:
        new_amount = _positive(amount, field="amount")
        # 护栏：返点金额不得低于累计已退，否则架空 return_rebate 的「累计退回≤金额」铁律。
        already = rebate_returned_totals(session, [record])[record.id]
        if new_amount < already:
            raise Validation(
                f"返点金额 {new_amount} 不得低于累计已退 {already}",
                details={"amount": str(new_amount), "already_returned": str(already)},
            )
        record.amount = new_amount
    if collected_on is not None:
        record.collected_on = collected_on
    if note is not None:
        record.note = note
    if operator_user_ids is not None:
        record.operator_user_ids = _validate_operator_user_ids(session, operator_user_ids)
    if form_extra is not None:
        record.form_extra = validate_form_extra(session, order_type_code="INVREBATE", values=form_extra) or None
    action_event = _rebate_action_event(session, record)
    if action_event is not None:
        action_event.amount = record.amount
        action_event.occurred_on = record.collected_on
        action_event.note = record.note
        action_event.updated_by = actor
        flow = session.scalar(select(Cashflow).where(Cashflow.order_event_id == action_event.id))
        if flow is not None:
            flow.amount = record.amount
            flow.occurred_on = record.collected_on
            flow.note = record.note or flow.note
            flow.updated_by = actor
    record.updated_by = actor
    session.flush()
    record_audit(session, action=AuditAction.REBATE_UPDATE, entity_type="rebate_record", entity_id=record.rebate_no, actor=actor, before=before, after={"amount": str(record.amount), "collected_on": str(record.collected_on), "note": record.note})
    return record


def _rebate_action_event(session: Session, record: RebateRecord) -> OrderEvent | None:
    """查找新动作模型的返点事件；旧记录没有该事件，继续走兼容口径。

    供 update_rebate 编辑时同步事件与资金流水的金额/日期，保持报表同源。
    """
    events = session.scalars(
        select(OrderEvent).where(
            OrderEvent.order_id == record.source_order_id,
            OrderEvent.event_type == "REBATE",
        )
    ).all()
    for event in events:
        if (event.form_extra or {}).get("rebate_record_id") == record.id:
            return event
    return None


def rebate_returned_totals(
    session: Session, records: list[RebateRecord]
) -> dict[int, Decimal]:
    """批量算每笔返点的累计已退，口径与 return_rebate 的下限校验严格同源。

    只认 category=REBATE_REVERSAL 且 form_extra.rebate_record_id 命中的挂单 OUT；
    归属判断在 Python 层做（禁 SQL json_extract/.astext，跨方言且聚合量小）。
    order_id 用批量 IN 查询，避免列表逐笔 N+1。
    """
    totals: dict[int, Decimal] = {record.id: Decimal("0.00") for record in records}
    if not totals:
        return totals
    order_ids = {record.source_order_id for record in records}
    flows = session.scalars(
        select(Cashflow).where(
            Cashflow.order_id.in_(order_ids),
            Cashflow.category == "REBATE_REVERSAL",
        )
    ).all()
    for flow in flows:
        rebate_id = (flow.form_extra or {}).get("rebate_record_id")
        if rebate_id in totals:
            totals[rebate_id] = to_money(totals[rebate_id] + to_money(flow.amount))
    return totals


def return_rebate(
    session: Session,
    *,
    rebate_id: int,
    amount: Any,
    returned_on: date,
    actor: str,
    note: str | None = None,
    user: CurrentUser | None = None,
) -> tuple[RebateRecord, Cashflow, Decimal]:
    """返点退回：在来源订单上记一笔真实 OUT 资金流水（REB-01 退回口径）。

    2026-11-12 裁决：返点登记即确认收入、不提供作废/删除；确实要退回该笔钱时
    记一笔真实 OUT 支出，发生日=真实退回日（自然归期），不再用 date.today() 的
    作废冲销撕裂 R2 / 资金日报的月度归期。

    口径（与押金「一套逻辑」同构，务必勿改）：
    - 挂单（order_id=来源订单）：收入侧返点保留、支出侧 +一笔 OUT，订单利润
      =收入−支出 自动冲减；R2 因 op_stmt 的 `order_id.is_(None)` 不会重复进运营费用，
      只在资金流水段计入该单直接成本。若记成独立流水（不带 order_id）则不冲订单利润，
      违背「利润=收入−支出」，是缺陷。
    - 累计退回不得超过该笔返点金额 amount（防重复/超额退回）；
      同一笔返点可分多次部分退回。
    - 资金池取原返点 IN 流水所在池，取不到再回退默认利润池，保证收支同池。

    返回 ``(返点记录, 退回流水, 退后累计已退)``。
    """
    record = get_rebate(session, rebate_id, user=user)
    if record.status == RebateStatus.VOID.value:
        raise Validation(
            "已作废的历史返点不可再退回", details={"rebate_id": rebate_id}
        )
    returned = _positive(amount, field="amount")
    if returned_on is None:
        raise Validation("退回日期必填", details={"field": "returned_on"})

    amount_total = to_money(record.amount)
    # 累计已退与列表下发、编辑护栏共用同一聚合函数，杜绝三处口径漂移。
    already = rebate_returned_totals(session, [record])[record.id]
    if already + returned > amount_total:
        raise Validation(
            f"累计退回 {already + returned} 超过返点金额 {amount_total}，可退余额 {amount_total - already}",
            details={
                "rebate_id": rebate_id,
                "amount": str(amount_total),
                "already_returned": str(already),
                "returned_amount": str(returned),
            },
        )

    order = get_order(session, record.source_order_id, user)
    # 取原返点 IN 流水所在池：该流水由 REBATE 事件派生，form_extra 带 rebate_record_id。
    # 在 Python 层比对归属（禁 SQL json_extract / .astext，跨方言且量小），收支同池。
    original_flows = session.scalars(
        select(Cashflow).where(
            Cashflow.order_id == record.source_order_id,
            Cashflow.direction == Direction.IN.value,
            Cashflow.category == "REBATE",
            Cashflow.order_event_id.is_not(None),
        )
    ).all()
    original_pool_id = next(
        (
            flow.pool_id
            for flow in original_flows
            if (flow.form_extra or {}).get("rebate_record_id") == record.id
        ),
        None,
    )
    if original_pool_id is not None:
        pool_id = int(original_pool_id)
    else:
        # 旧模型返点无派生流水，回退默认利润池；池可用性由 create_cashflow 内校验。
        fallback = resolve_default_pool(
            session,
            order.order_type,
            Portion.PROFIT.value,
            fund_nature=FundNature.BUSINESS.value,
        )
        if fallback is None:
            raise Validation(
                f"业务 {order.order_type} 未配置 {Portion.PROFIT.value} 资金池，无法登记返点退回",
                code=ErrorCode.POOL_ROUTE_MISSING,
                details={"order_type": order.order_type, "portion": Portion.PROFIT.value},
            )
        pool_id = fallback.id

    from app.finance.cashflows import create_cashflow

    flow = create_cashflow(
        session,
        pool_id=pool_id,
        occurred_on=returned_on,
        direction=Direction.OUT.value,
        nature=Nature.BUSINESS_OUT.value,
        category="REBATE_REVERSAL",
        amount=returned,
        order_id=order.id,
        note=note or f"{record.rebate_no} 返点退回",
        form_extra={"rebate_record_id": record.id},
        form_extra_scope="FUNDFLOW",
        actor=actor,
        user=user,
    )
    record_audit(
        session,
        action=AuditAction.REBATE_RETURN,
        entity_type="rebate_record",
        entity_id=record.rebate_no,
        actor=actor,
        after={
            "source_order": order.order_no,
            "amount": str(returned),
            "already_returned_before": str(already),
            "returned_on": returned_on.isoformat(),
            "flow_no": flow.flow_no,
        },
    )
    return record, flow, to_money(already + returned)


# 2026-11-12 裁决：返点登记即确认收入，不提供作废/删除。
# 原 delete_rebate（reverse_cashflow + 置 VOID）移除；返点不再有 VOID 写入路径。
# 退回走 return_rebate：在来源订单记一笔挂单真实 OUT（REBATE_REVERSAL），
# 发生日=真实退回日、自然归期，不撕裂 R2 / 资金日报；累计退回≤返点金额。
# RebateStatus.VOID 枚举与收入侧 `status != VOID` 过滤保留，兼容历史已作废数据。

__all__ = [
    "create_rebate",
    "get_rebate",
    "list_rebates",
    "rebate_returned_totals",
    "return_rebate",
    "update_rebate",
]

