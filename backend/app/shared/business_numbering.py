"""面向业务的从属编号生成器。"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.domain.trade import (
    Order,
    OrderEvent,
    Installment,
    RebateRecord,
)


def _lock_row(session: Session, model, row_id: int) -> None:
    """锁住编号所属主记录，避免并发事务同时生成同一个从属编号。"""
    session.execute(
        select(model.id).where(model.id == row_id).with_for_update()
    ).first()


def event_no(session: Session, *, order_no: str, order_id: int, event_type: str) -> str:
    _lock_row(session, Order, order_id)
    count = session.scalar(
        select(func.count(OrderEvent.id)).where(
            OrderEvent.order_id == order_id,
            OrderEvent.event_type == event_type,
        )
    ) or 0
    return f"{order_no}-EV-{event_type}-{count + 1:02d}"


def installment_no(session: Session, *, order_no: str, order_id: int) -> str:
    """同一订单保留取消历史，后续合约使用递增编号。"""
    _lock_row(session, Order, order_id)
    used = set(session.scalars(select(Installment.inst_no).where(Installment.order_id == order_id)).all())
    if f"{order_no}-FQ" not in used:
        return f"{order_no}-FQ"
    sequence = 2
    while f"{order_no}-FQ-{sequence:02d}" in used:
        sequence += 1
    return f"{order_no}-FQ-{sequence:02d}"


def rebate_no(session: Session, *, order_no: str, order_id: int) -> str:
    _lock_row(session, Order, order_id)
    count = session.scalar(
        select(func.count(RebateRecord.id)).where(RebateRecord.source_order_id == order_id)
    ) or 0
    return f"{order_no}-RB{count + 1:02d}"


__all__ = [
    "event_no",
    "installment_no",
    "rebate_no",
]
