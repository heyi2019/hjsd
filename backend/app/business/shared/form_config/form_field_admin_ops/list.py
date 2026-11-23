"""表单字段列表查询。"""
from __future__ import annotations
from sqlalchemy import or_, select
from sqlalchemy.orm import Session
from app.domain.trade import OrderFormField
from app.domain.form_scopes import REQUIRED_CORE_FIELDS

def list_order_form_fields(
    session: Session, *, order_type_code: str, include_inactive: bool = True
) -> list[OrderFormField]:
    code = order_type_code.strip().upper()
    stmt = select(OrderFormField).where(OrderFormField.order_type_code == code)
    if not include_inactive:
        stmt = stmt.where(or_(OrderFormField.is_active.is_(True), OrderFormField.field_key.in_(REQUIRED_CORE_FIELDS.get(code, ()))))
    return list(session.scalars(stmt.order_by(OrderFormField.sort_order, OrderFormField.id)))
