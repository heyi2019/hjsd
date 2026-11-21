"""订单详情编辑总编排。

这里只编排一次保存事务；具体写入分别位于 events、cashflows、orders 和 parties。
"""
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.core.security import CurrentUser
from app.domain.trade import Account, Order
from app.business.stocks.profile import update_account_profile

from .schemas import ExecutionEditRequest
from .cashflows import apply_cashflow_edits
from .events import apply_event_edits, apply_operation_event_creates, validate_event_edits
from .orders import apply_order_edits
from .parties import apply_party_edits


def edit_execution_detail(db: Session, order_id: int, payload: ExecutionEditRequest, user: CurrentUser) -> None:
    """保存订单详情编辑，所有变更在当前请求事务内完成。"""
    order = db.scalar(select(Order).where(Order.id == order_id).with_for_update())
    if order is None or order.account_id is None:
        raise Validation("订单未关联库存账号", details={"order_id": order_id})
    account = db.scalar(select(Account).where(Account.id == order.account_id).with_for_update())
    if account is None:
        raise Validation("订单未关联库存账号", details={"order_id": order_id})
    for item in payload.new_events:
        if item.operation_type == "UNLIST" and (item.form_extra or {}).get("platform_unlist_scope") == "SYSTEM":
            raise Validation("本系统下架请通过下架操作执行")
    if len({item.id for item in payload.events}) != len(payload.events):
        raise Validation("同一执行记录不能重复修改")
    if len({item.flow_no for item in payload.cashflows}) != len(payload.cashflows):
        raise Validation("同一资金明细不能重复修改")
    if len({item.order_id for item in payload.orders}) != len(payload.orders):
        raise Validation("同一订单不能重复修改")

    event_changes, cost_delta = validate_event_edits(db, account, order_id, payload, user)
    if payload.profile is not None:
        profile = payload.profile.model_dump(exclude_unset=True)
        if profile.keys() - {"account_description", "account_images"}:
            profile.setdefault("form_extra", {})
        update_account_profile(
            db,
            account.id,
            actor=user.username,
            user=user,
            **profile,
        )
    apply_event_edits(db, event_changes, user.username)
    apply_operation_event_creates(db, order_id, payload.new_events, user.username, user)
    apply_cashflow_edits(db, account.id, order, payload.cashflows, user)
    apply_order_edits(db, account.id, order_id, payload.orders, user)
    apply_party_edits(db, account.id, order_id, payload.parties, user)

    account.cost_amount = Decimal(str(account.cost_amount)) + cost_delta
    if event_changes:
        account.updated_by = user.username
    db.flush()
