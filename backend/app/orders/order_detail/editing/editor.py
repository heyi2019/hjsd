"""订单详情编辑总编排。

这里只编排一次保存事务；具体写入分别位于 events、cashflows、orders 和 parties。
"""
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.core.security import CurrentUser
from app.domain.trade import Account
from app.stocks.profile import get_account, update_account_profile

from .schemas import ExecutionEditRequest
from .cashflows import apply_cashflow_edits
from .events import apply_event_edits, validate_event_edits
from .orders import apply_order_edits
from .parties import apply_party_edits


def edit_execution_detail(db: Session, account_id: int, payload: ExecutionEditRequest, user: CurrentUser) -> None:
    """保存订单详情编辑，所有变更在当前请求事务内完成。"""
    account = get_account(db, account_id, user)
    db.scalar(select(Account).where(Account.id == account_id).with_for_update())
    if len({item.id for item in payload.events}) != len(payload.events):
        raise Validation("同一执行记录不能重复修改")
    if len({item.flow_no for item in payload.cashflows}) != len(payload.cashflows):
        raise Validation("同一资金明细不能重复修改")
    if len({item.order_id for item in payload.orders}) != len(payload.orders):
        raise Validation("同一订单不能重复修改")

    event_changes, cost_delta = validate_event_edits(db, account, payload, user)
    if payload.profile is not None:
        update_account_profile(
            db,
            account_id,
            actor=user.username,
            user=user,
            **payload.profile.model_dump(exclude_unset=True),
        )
    apply_event_edits(db, event_changes, user.username)
    apply_cashflow_edits(db, account_id, payload.cashflows, user)
    apply_order_edits(db, account_id, payload.orders, user)
    apply_party_edits(db, account_id, payload.parties, user)

    account.cost_amount = Decimal(str(account.cost_amount)) + cost_delta
    if event_changes:
        account.updated_by = user.username
    db.flush()
