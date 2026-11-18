"""表单字段列表查询。"""
from __future__ import annotations
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.domain.trade import OrderFormField

def list_order_form_fields(
    session: Session, *, order_type_code: str, include_inactive: bool = True
) -> list[OrderFormField]:
    stmt = select(OrderFormField).where(
        OrderFormField.order_type_code == order_type_code.strip().upper()
    )
    if not include_inactive:
        stmt = stmt.where(OrderFormField.is_active.is_(True))
    return list(session.scalars(stmt.order_by(OrderFormField.sort_order, OrderFormField.id)))
