"""订单详情中的订单补充字段编辑。"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.shared.option_snapshots import update_option_label_snapshot
from app.core.errors import NotFound
from app.core.security import CurrentUser
from app.domain.trade import Order
from app.business.orders.mutations import _shift_accounting_dates
from app.shared.form_field_rules import validate_business_responsible

from .schemas import ExecutionOrderEditItem


def apply_order_edits(db: Session, account_id: int, target_order_id: int, items: list[ExecutionOrderEditItem], user: CurrentUser) -> None:
    for item in items:
        order = db.scalar(select(Order).where(Order.id == item.order_id).with_for_update())
        if order is None or order.id != target_order_id or order.account_id != account_id:
            raise NotFound("订单不存在")
        before = {"note": order.note, "trade_date": order.trade_date.isoformat(), "occurred_at": order.created_at.isoformat() if order.created_at else None, "operator": order.created_by, "form_extra": order.form_extra}
        shift_info = {}
        if "note" in item.model_fields_set:
            order.note = item.note
        if "form_extra" in item.model_fields_set and item.form_extra is not None:
            next_extra = {**(order.form_extra or {}), **item.form_extra}
            validate_business_responsible(db, order_type_code=order.order_type, values=next_extra)
            order.option_label_snapshot = update_option_label_snapshot(db, order.option_label_snapshot, order.form_extra, next_extra, scopes=(order.order_type, "ORDEREDIT")) or None
            order.form_extra = next_extra
        if "occurred_at" in item.model_fields_set and item.occurred_at is not None:
            occurred_at = item.occurred_at.replace(tzinfo=None)
            if occurred_at.date() != order.trade_date:
                shift_info = _shift_accounting_dates(db, order, actor=user.username, new_trade_date=occurred_at.date())
            order.created_at = occurred_at
            order.trade_date = occurred_at.date()
        order.updated_by = user.username
        record_audit(db, action="ORDER_UPDATE", entity_type="inventory_order_edit", entity_id=order.order_no, actor=user.username, before=before, after={"note": order.note, "trade_date": order.trade_date.isoformat(), "occurred_at": order.created_at.isoformat() if order.created_at else None, "operator": order.created_by, "form_extra": order.form_extra, **shift_info})
