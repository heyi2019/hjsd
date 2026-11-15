"""finance 资金池间划转服务（FIN-06）。"""
from __future__ import annotations

from datetime import date
from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.money import to_money
from app.core.numbering import allocate_flow_no
from app.core.security import CurrentUser
from app.domain.enums import AccountingAttribute, AuditAction, Direction, FundNature, Nature
from app.domain.trade import Cashflow
from app.orders.form_fields import validate_form_extra
from app.finance.balances import pool_balance
from app.foundation.pools import assert_pool_usable

from ._common import _positive, _text

def create_transfer(
    session: Session,
    *,
    source_pool_id: int,
    target_pool_id: int,
    amount: Any,
    occurred_on: date,
    actor: str,
    note: str | None = None,
    form_extra: dict[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """原子生成一出一入的 INTERNAL 流水，完成池间转移且不改变合并现金。"""
    if source_pool_id == target_pool_id:
        raise Validation("转出池与转入池不能相同", details={"pool_id": source_pool_id})
    if user is not None and (
        not user.can_see_pool(source_pool_id) or not user.can_see_pool(target_pool_id)
    ):
        raise NotFound("资金池不存在", details={"pool_id": source_pool_id})
    money = _positive(amount, field="amount")
    source = assert_pool_usable(session, source_pool_id)
    target = assert_pool_usable(session, target_pool_id)
    available = to_money(pool_balance(session, source.id, user=user)["available"])
    if money > available:
        raise Validation(
            "转出资金池可用余额不足",
            details={
                "source_pool_id": source.id,
                "amount": str(money),
                "available": str(available),
            },
        )
    # Cashflow.flow_no 长度为 32；保留可读前缀并控制两条流水编号不超列长度。
    transfer_id = f"TRF-{uuid4().hex[:20].upper()}"
    common = {
        "transfer_id": transfer_id,
        "occurred_on": occurred_on,
        "nature": Nature.INTERNAL.value,
        "fund_nature": FundNature.INTERNAL.value,
        "accounting_attribute": AccountingAttribute.INTERNAL_TRANSFER.value,
        "category": "TRANSFER",
        "amount": money,
        "created_by": actor,
        "updated_by": actor,
        "form_extra": validate_form_extra(session, order_type_code="FUNDTRANSFER", values=form_extra) or None,
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
    form_extra: dict[str, Any] | None = None,
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
    if user is not None and (
        not user.can_see_pool(source.pool_id) or not user.can_see_pool(counterpart_pool_id)
    ):
        raise NotFound("资金池不存在", details={"pool_id": counterpart_pool_id})
    target = assert_pool_usable(session, counterpart_pool_id)
    if target.id == source.pool_id:
        raise Validation("修复对端资金池不能与原资金池相同")
    if source.direction == Direction.OUT.value:
        direction = Direction.IN.value
    elif source.direction == Direction.IN.value:
        direction = Direction.OUT.value
    else:
        raise Validation("单边划转方向无效", details={"transfer_id": transfer})
    flow = Cashflow(
        flow_no=allocate_flow_no(session, direction),
        pool_id=target.id,
        occurred_on=source.occurred_on,
        nature=Nature.INTERNAL.value,
        fund_nature=FundNature.INTERNAL.value,
        accounting_attribute=AccountingAttribute.INTERNAL_TRANSFER.value,
        category="TRANSFER",
        direction=direction,
        amount=to_money(source.amount),
        transfer_id=transfer,
        status=source.status,
        reviewed_by=source.reviewed_by,
        reviewed_at=source.reviewed_at,
        note=f"修复划转 {transfer}: {text_reason}",
        form_extra=validate_form_extra(session, order_type_code="FUNDREPAIR", values=form_extra) or None,
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

__all__ = [
    "create_transfer",
    "repair_transfer",
]

