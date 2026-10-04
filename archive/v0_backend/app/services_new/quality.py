"""异常工作台的数据质量检查（PRD V1–V34 的可自动化部分）。"""
from __future__ import annotations

from datetime import date
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models_new.entities import CashFlow, Installment, Order, OrderEvent, RebateRecord
from app.services_new.ledger import transfer_symmetry


def exception_dashboard(db: Session, as_of: date | None = None) -> dict:
    """返回需要人工处理的异常计数与清单，不对历史孤儿数据做自动修复。"""
    as_of = as_of or date.today()
    stale_before = date.fromordinal(as_of.toordinal() - 7)
    stock_buy_without_account = db.query(OrderEvent).join(Order).filter(
        Order.capital_type.in_(("STOCK", "CREDIT")),
        OrderEvent.event_type == "BUY",
        Order.account_id.is_(None),
    ).all()
    unlinked_rebates = db.query(RebateRecord).filter(
        RebateRecord.link_status != "LINKED"
    ).all()
    stale = db.query(Order).join(OrderEvent).filter(
        Order.link_status == "LINKED", Order.capital_type.in_(("STOCK", "CREDIT")),
        OrderEvent.event_type == "BUY", OrderEvent.occurred_on < stale_before,
    ).all()
    invalid_installments = db.query(Installment).filter(
        (Installment.down_payment > Installment.principal) |
        (Installment.principal > Installment.down_payment + Installment.periods * Installment.per_period)
    ).all()
    transfer = transfer_symmetry(db)
    return {
        "unlinked_rebates": {"count": len(unlinked_rebates), "ids": [r.id for r in unlinked_rebates]},
        "stock_buy_without_account": {"count": len(stock_buy_without_account), "event_nos": [e.event_no for e in stock_buy_without_account]},
        "stale_linked_orders": {"count": len(stale), "order_nos": sorted({o.order_no for o in stale})},
        "invalid_installments": {"count": len(invalid_installments), "inst_nos": [i.inst_no for i in invalid_installments]},
        "unpaired_transfers": transfer,
    }
