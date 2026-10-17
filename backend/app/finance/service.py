"""finance 资金服务门面：现金流、押金、对账与资金划转。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from collections.abc import Iterable
from typing import Any
from uuid import uuid4

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Conflict, NotFound, Validation
from app.core.errors import ErrorCode
from app.core.money import to_money
from app.core.numbering import allocate_number
from app.core.periods import assert_period_open
from app.core.security import CurrentUser
from app.domain.enums import (
    AuditAction,
    CashflowStatus,
    DepositStatus,
    Direction,
    Nature,
    ReconciliationStatus,
    SequenceKey,
)
from app.domain.trade import (
    Cashflow,
    Deposit,
    Reconciliation,
)
from app.foundation import service as foundation_service

from ._common import _non_negative, _positive, _text
from .rebates import (
    create_rebate,
    get_rebate,
    list_overdue_rebates,
    list_rebate_settlements,
    list_rebates,
    reverse_rebate_settlement,
    settle_rebate,
    settled_net_total,
    sync_overdue_rebate_notifications,
)
from .cashflows import (
    approve_cashflow,
    create_cashflow,
    create_deposit,
    create_period_lock,
    list_cashflows,
    list_deposits,
    list_period_locks,
    lose_deposit,
    reject_cashflow,
    return_deposit,
    reverse_cashflow,
)


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
    value = session.scalar(
        select(func.coalesce(func.sum(signed_amount), 0)).where(
            Cashflow.pool_id == pool_id,
            Cashflow.occurred_on <= reconciled_on,
            Cashflow.status == CashflowStatus.APPROVED.value,
        )
    )
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
    user: CurrentUser | None = None,
) -> Reconciliation:
    if user is not None and not user.can_see_pool(pool_id):
        raise NotFound("资金池不存在", details={"pool_id": pool_id})
    pool = foundation_service.assert_pool_usable(session, pool_id)
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
        raise Validation("同一资金池、日期和账户只能对账一次")

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
                "未达流水必须属于当前资金池且不晚于对账日",
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
    if difference != 0 and not text_reason:
        raise Validation("存在差异时必须填写差异原因", details={"field": "reason"})
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
    item.resolved_at = datetime.now()
    item.reason = f"{item.reason}; {text_reason}" if item.reason else text_reason
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
    return item


def create_transfer(
    session: Session,
    *,
    source_pool_id: int,
    target_pool_id: int,
    amount: Any,
    occurred_on: date,
    actor: str,
    note: str | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """原子生成一出一入的 INTERNAL 流水，完成池间转移且不改变合并现金。"""
    assert_period_open(session, occurred_on, operation="创建资金划转")
    if source_pool_id == target_pool_id:
        raise Validation("转出池与转入池不能相同", details={"pool_id": source_pool_id})
    if user is not None and (
        not user.can_see_pool(source_pool_id) or not user.can_see_pool(target_pool_id)
    ):
        raise NotFound("资金池不存在", details={"pool_id": source_pool_id})
    money = _positive(amount, field="amount")
    source = foundation_service.assert_pool_usable(session, source_pool_id)
    target = foundation_service.assert_pool_usable(session, target_pool_id)
    # Cashflow.flow_no 长度为 32；保留可读前缀并控制两条流水编号不超列长度。
    transfer_id = f"TRF-{uuid4().hex[:20].upper()}"
    common = {
        "transfer_id": transfer_id,
        "occurred_on": occurred_on,
        "nature": Nature.INTERNAL.value,
        "category": "TRANSFER",
        "amount": money,
        "created_by": actor,
        "updated_by": actor,
    }
    outgoing = Cashflow(
        flow_no=f"{transfer_id}-OUT",
        pool_id=source.id,
        direction=Direction.OUT.value,
        note=note,
        **common,
    )
    incoming = Cashflow(
        flow_no=f"{transfer_id}-IN",
        pool_id=target.id,
        direction=Direction.IN.value,
        note=note,
        **common,
    )
    session.add_all([outgoing, incoming])
    session.flush()
    record_audit(
        session,
        action=AuditAction.TRANSFER_CREATE,
        entity_type="transfer",
        entity_id=transfer_id,
        actor=actor,
        after={
            "source_pool": source.code,
            "target_pool": target.code,
            "amount": str(money),
        },
    )
    return {
        "transfer_id": transfer_id,
        "source_pool_id": source.id,
        "target_pool_id": target.id,
        "amount": money,
        "occurred_on": occurred_on,
        "cashflows": [outgoing, incoming],
    }


def repair_transfer(
    session: Session,
    transfer_id: str,
    *,
    counterpart_pool_id: int,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """只为单边内部划转补齐缺失的一边，禁止把异常静默当成正常新划转。"""
    text_reason = _text(
        reason,
        field="reason",
        message="划转修复必须填写原因",
        type_message="划转修复必须填写原因",
    )
    transfer = _text(
        transfer_id,
        field="transfer_id",
        message="transfer_id 不能为空",
        type_message="transfer_id 必须为文本",
    )
    rows = list(
        session.scalars(
            select(Cashflow)
            .where(
                Cashflow.transfer_id == transfer,
                Cashflow.nature == Nature.INTERNAL.value,
            )
            .order_by(Cashflow.id)
        ).all()
    )
    if not rows:
        raise NotFound(f"划转 {transfer} 不存在", details={"transfer_id": transfer})
    if len(rows) == 2:
        raise Validation("该划转已完整，不能重复修复", details={"transfer_id": transfer})
    if len(rows) != 1:
        raise Validation("该划转不是单边记录，不能自动修复", details={"transfer_id": transfer})
    source = rows[0]
    assert_period_open(session, source.occurred_on, operation="修复历史资金划转")
    if user is not None and (
        not user.can_see_pool(source.pool_id) or not user.can_see_pool(counterpart_pool_id)
    ):
        raise NotFound("资金池不存在", details={"pool_id": counterpart_pool_id})
    target = foundation_service.assert_pool_usable(session, counterpart_pool_id)
    if target.id == source.pool_id:
        raise Validation("修复对端资金池不能与原资金池相同")
    if source.direction == Direction.OUT.value:
        direction = Direction.IN.value
    elif source.direction == Direction.IN.value:
        direction = Direction.OUT.value
    else:
        raise Validation("单边划转方向无效", details={"transfer_id": transfer})
    flow = Cashflow(
        flow_no=allocate_number(session, SequenceKey.CASHFLOW.value),
        pool_id=target.id,
        occurred_on=source.occurred_on,
        nature=Nature.INTERNAL.value,
        category="TRANSFER",
        direction=direction,
        amount=to_money(source.amount),
        transfer_id=transfer,
        status=source.status,
        reviewed_by=source.reviewed_by,
        reviewed_at=source.reviewed_at,
        note=f"修复划转 {transfer}: {text_reason}",
        created_by=actor,
        updated_by=actor,
    )
    session.add(flow)
    session.flush()
    record_audit(
        session,
        action=AuditAction.TRANSFER_REPAIR,
        entity_type="transfer",
        entity_id=transfer,
        actor=actor,
        after={
            "source_flow_id": source.id,
            "repaired_flow_id": flow.id,
            "counterpart_pool_id": target.id,
            "amount": str(flow.amount),
        },
        reason=text_reason,
    )
    return {
        "transfer_id": transfer,
        "source_pool_id": source.pool_id if source.direction == Direction.OUT.value else target.id,
        "target_pool_id": target.id if source.direction == Direction.OUT.value else source.pool_id,
        "amount": to_money(source.amount),
        "occurred_on": source.occurred_on,
        "cashflows": [source, flow],
    }


def deposit_held_total(session: Session, pool_id: int | None = None) -> Decimal:
    stmt = select(
        func.coalesce(
            func.sum(Deposit.paid_amount - Deposit.returned_amount - Deposit.lost_amount),
            0,
        )
    )
    if pool_id:
        stmt = stmt.where(Deposit.pool_id == pool_id)
    return to_money(session.scalar(stmt) or 0)




__all__ = [
    "approve_cashflow",
    "create_cashflow",
    "create_deposit",
    "create_rebate",
    "deposit_held_total",
    "list_cashflows",
    "create_reconciliation",
    "list_reconciliations",
    "resolve_reconciliation",
    "list_deposits",
    "list_rebates",
    "list_overdue_rebates",
    "sync_overdue_rebate_notifications",
    "get_rebate",
    "create_transfer",
    "repair_transfer",
    "return_deposit",
    "lose_deposit",
    "reject_cashflow",
    "reverse_cashflow",
    "settle_rebate",
    "list_rebate_settlements",
    "reverse_rebate_settlement",
    "settled_net_total",
]
