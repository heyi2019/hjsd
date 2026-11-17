"""finance 日对账服务（FIN-05）。"""
from __future__ import annotations

from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.time import now_second
from app.core.money import to_money
from app.core.operation_operators import upsert_operation_operators
from app.core.security import CurrentUser
from app.domain.enums import AuditAction, Direction, ReconciliationStatus
from app.domain.trade import Cashflow, Reconciliation
from app.orders.form_fields import validate_form_extra
from app.foundation.pools import assert_pool_usable

from ._common import _non_negative, _text

# --------------------------------------------------------------------- 日对账
def _get_reconciliation(
    session: Session,
    reconciliation_id: int,
    user: CurrentUser | None = None,
) -> Reconciliation:
    item = session.get(Reconciliation, reconciliation_id)
    if item is None or (user is not None and not user.can_see_pool(item.pool_id)):
        raise NotFound(
            f"对账记录 {reconciliation_id} 不存在",
            details={"reconciliation_id": reconciliation_id},
        )
    return item


def _system_balance_as_of(session: Session, pool_id: int, reconciled_on: date) -> Decimal:
    signed_amount = case(
        (Cashflow.direction == Direction.IN.value, Cashflow.amount),
        else_=-Cashflow.amount,
    )
    conditions = [
            Cashflow.pool_id == pool_id,
            Cashflow.occurred_on <= reconciled_on,
        ]
    value = session.scalar(select(func.coalesce(func.sum(signed_amount), 0)).where(*conditions))
    # 账户余额可能因历史支出而低于零，但资金快照本身仍必须能记录它。
    return to_money(value or 0)


def create_reconciliation(
    session: Session,
    *,
    pool_id: int,
    reconciled_on: date,
    account_label: str,
    statement_balance: Any,
    actor: str,
    unmatched_flow_ids: Iterable[int] | None = None,
    reason: str | None = None,
    note: str | None = None,
    form_extra: dict[str, Any] | None = None,
    operator_user_ids: list[int] | None = None,
    user: CurrentUser | None = None,
) -> Reconciliation:
    if user is not None and not user.can_see_pool(pool_id):
        raise NotFound("资金账户不存在", details={"pool_id": pool_id})
    pool = assert_pool_usable(session, pool_id)
    label = _text(
        account_label,
        field="account_label",
        message="对账账户不能为空",
        type_message="对账账户必须为文本",
    )
    statement = _non_negative(statement_balance, field="statement_balance")
    duplicate = session.scalar(
        select(Reconciliation.id).where(
            Reconciliation.pool_id == pool.id,
            Reconciliation.reconciled_on == reconciled_on,
            Reconciliation.account_label == label,
        )
    )
    if duplicate is not None:
        raise Validation("同一资金账户、日期和账户只能对账一次")

    try:
        raw_ids = list(unmatched_flow_ids or [])
    except TypeError as exc:
        raise Validation(
            "未达流水 ID 列表格式无效",
            details={"field": "unmatched_flow_ids"},
        ) from exc
    invalid_ids = [
        flow_id
        for flow_id in raw_ids
        if isinstance(flow_id, bool) or not isinstance(flow_id, int) or flow_id <= 0
    ]
    if invalid_ids:
        raise Validation(
            "未达流水 ID 必须为正整数",
            details={"field": "unmatched_flow_ids", "invalid": invalid_ids},
        )
    if len(raw_ids) != len(set(raw_ids)):
        raise Validation("未达流水不能重复", details={"field": "unmatched_flow_ids"})
    if raw_ids:
        flows = list(
            session.scalars(select(Cashflow).where(Cashflow.id.in_(raw_ids))).all()
        )
        by_id = {flow.id: flow for flow in flows}
        missing = [flow_id for flow_id in raw_ids if flow_id not in by_id]
        if missing:
            raise Validation(
                "未达流水不存在",
                details={"field": "unmatched_flow_ids", "missing": missing},
            )
        invalid = [
            flow.id
            for flow in flows
            if flow.pool_id != pool.id or flow.occurred_on > reconciled_on
        ]
        if invalid:
            raise Validation(
                "未达流水必须属于当前资金账户且不晚于对账日",
                details={"field": "unmatched_flow_ids", "invalid": invalid},
            )

    system_balance = _system_balance_as_of(session, pool.id, reconciled_on)
    difference = to_money(statement - system_balance)
    text_reason = _text(
        reason,
        field="reason",
        message="存在差异时必须填写差异原因",
        required=difference != 0,
        type_message="存在差异时必须填写差异原因",
    )
    item = Reconciliation(
        pool_id=pool.id,
        reconciled_on=reconciled_on,
        account_label=label,
        system_balance=system_balance,
        statement_balance=statement,
        difference=difference,
        status=ReconciliationStatus.OPEN.value,
        reason=text_reason or None,
        unmatched_flow_ids=raw_ids,
        note=note,
        form_extra=validate_form_extra(session, order_type_code="FUNDRECON", values=form_extra) or None,
        created_by=actor,
        updated_by=actor,
    )
    session.add(item)
    session.flush()
    record_audit(
        session,
        action=AuditAction.RECONCILIATION_CREATE,
        entity_type="reconciliation",
        entity_id=str(item.id),
        actor=actor,
        after={
            "pool_id": pool.id,
            "reconciled_on": reconciled_on.isoformat(),
            "system_balance": str(system_balance),
            "statement_balance": str(statement),
            "difference": str(difference),
            "unmatched_flow_ids": raw_ids,
        },
        reason=text_reason or None,
    )
    upsert_operation_operators(
        session,
        entity_type="reconciliation",
        entity_id=item.id,
        operation_key="CREATE",
        actor=actor,
        operator_user_ids=operator_user_ids,
        occurred_at=item.created_at,
    )
    return item


def list_reconciliations(
    session: Session,
    *,
    pool_id: int | None = None,
    pool_ids: Iterable[int] | None = None,
    user: CurrentUser | None = None,
) -> list[Reconciliation]:
    stmt = select(Reconciliation)
    if pool_id is not None:
        if user is not None and not user.can_see_pool(pool_id):
            return []
        stmt = stmt.where(Reconciliation.pool_id == pool_id)
    elif pool_ids is not None:
        visible_pool_ids = list(pool_ids)
        if user is not None and not (user.is_admin or user.owner_scope == "ALL"):
            visible_pool_ids = [pool for pool in visible_pool_ids if user.can_see_pool(pool)]
        stmt = stmt.where(Reconciliation.pool_id.in_(visible_pool_ids))
    elif user is not None and not (user.is_admin or user.owner_scope == "ALL"):
        stmt = stmt.where(Reconciliation.pool_id.in_(sorted(user.pool_ids)))
    return list(
        session.scalars(
            stmt.order_by(
                Reconciliation.reconciled_on.desc(), Reconciliation.id.desc()
            )
        ).all()
    )


def resolve_reconciliation(
    session: Session,
    reconciliation_id: int,
    *,
    actor: str,
    reason: str,
    form_extra: dict[str, Any] | None = None,
    operator_user_ids: list[int] | None = None,
    user: CurrentUser | None = None,
) -> Reconciliation:
    text_reason = _text(
        reason,
        field="reason",
        message="核销对账必须填写处理说明",
        type_message="核销对账必须填写处理说明",
    )
    item = _get_reconciliation(session, reconciliation_id, user)
    if item.status != ReconciliationStatus.OPEN.value:
        raise Validation("该对账记录已核销", details={"reconciliation_id": item.id})
    item.status = ReconciliationStatus.RESOLVED.value
    item.resolved_by = actor
    item.resolved_at = now_second()
    item.reason = f"{item.reason}; {text_reason}" if item.reason else text_reason
    if form_extra:
        item.form_extra = {**(item.form_extra or {}), **validate_form_extra(session, order_type_code="FUNDCLEAR", values=form_extra)}
    item.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.RECONCILIATION_RESOLVE,
        entity_type="reconciliation",
        entity_id=str(item.id),
        actor=actor,
        after={"status": item.status, "resolved_by": actor},
        reason=text_reason,
    )
    upsert_operation_operators(
        session,
        entity_type="reconciliation",
        entity_id=item.id,
        operation_key="RESOLVE",
        actor=actor,
        operator_user_ids=operator_user_ids,
    )
    return item


__all__ = [
    "create_reconciliation",
    "list_reconciliations",
    "resolve_reconciliation",
]
