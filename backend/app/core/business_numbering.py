"""面向业务的从属编号生成器。"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.domain.trade import Cashflow, OrderEvent, RebateRecord, RebateSettlement


def event_no(session: Session, *, order_no: str, order_id: int, event_type: str) -> str:
    count = session.scalar(
        select(func.count(OrderEvent.id)).where(
            OrderEvent.order_id == order_id,
            OrderEvent.event_type == event_type,
        )
    ) or 0
    return f"{order_no}-EV-{event_type}-{count + 1:02d}"


def cashflow_no(
    session: Session, *, order_no: str, order_id: int, category: str
) -> str:
    count = session.scalar(
        select(func.count(Cashflow.id))
        .join(OrderEvent, Cashflow.order_event_id == OrderEvent.id)
        .where(
            OrderEvent.order_id == order_id,
            Cashflow.category == category,
        )
    ) or 0
    return f"{order_no}-CF-{category}-{count + 1:02d}"


def installment_no(order_no: str) -> str:
    return f"{order_no}-INS01"


def rebate_no(session: Session, *, order_no: str, order_id: int) -> str:
    count = session.scalar(
        select(func.count(RebateRecord.id)).where(RebateRecord.source_order_id == order_id)
    ) or 0
    return f"{order_no}-RB{count + 1:02d}"


def rebate_settlement_no(session: Session, *, rebate_no: str, rebate_record_id: int) -> str:
    count = session.scalar(
        select(func.count(RebateSettlement.id)).where(
            RebateSettlement.rebate_record_id == rebate_record_id
        )
    ) or 0
    return f"{rebate_no}-CF-{count + 1:02d}"


__all__ = [
    "cashflow_no",
    "event_no",
    "installment_no",
    "rebate_no",
    "rebate_settlement_no",
]
