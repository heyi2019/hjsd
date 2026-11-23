"""订单详情编辑总编排。

这里只编排一次保存事务；具体写入分别位于 events、cashflows、orders 和 parties。
"""
import json
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import Conflict, ErrorCode, Validation
from app.core.security import CurrentUser
from app.domain.trade import Account, Order
from app.business.inventory.profile import update_account_profile

from .schemas import ExecutionEditRequest
from .cashflows import apply_cashflow_edits, lock_edit_pools, prepare_cashflow_event_edits
from .events import apply_event_edits, apply_operation_event_creates, validate_event_edits
from .orders import apply_order_edits
from .parties import apply_party_edits


def _checked_profile(account: Account, profile: dict, expected: dict[str, object]) -> dict:
    """只比较实际修改字段；同字段变化时拒绝整次保存。"""
    if set(profile) != set(expected):
        raise Validation("账号资料的并发检查字段不完整")
    for field, value in profile.items():
        previous = expected[field]
        if field in {"extra_values", "form_extra"}:
            if not isinstance(value, dict) or not isinstance(previous, dict) or set(value) != set(previous):
                raise Validation("账号扩展资料的并发检查字段不完整", details={"field": field})
            for key, original in previous.items():
                actual = (account.form_extra or {}).get(key)
                if json.dumps(actual, sort_keys=True, ensure_ascii=False) != json.dumps(original, sort_keys=True, ensure_ascii=False):
                    raise Conflict("账号资料已被其他人修改，请刷新后重试", code=ErrorCode.VERSION_CONFLICT, details={"field": field})
        elif json.dumps(getattr(account, field), sort_keys=True, ensure_ascii=False) != json.dumps(previous, sort_keys=True, ensure_ascii=False):
            raise Conflict("账号资料已被其他人修改，请刷新后重试", code=ErrorCode.VERSION_CONFLICT, details={"field": field})

    if "form_extra" in profile:
        # 以锁定后的当前值校验必填字段，只覆盖本次修改的字段。
        changed_extras = profile.get("extra_values") or {}
        current = {key: value for key, value in (account.form_extra or {}).items() if key not in changed_extras}
        profile["form_extra"] = {**current, **profile["form_extra"]}
    return profile


def edit_execution_detail(db: Session, order_id: int, payload: ExecutionEditRequest, user: CurrentUser) -> None:
    """保存订单详情编辑，所有变更在当前请求事务内完成。"""
    order = db.scalar(select(Order).where(Order.id == order_id).with_for_update())
    if order is None or order.account_id is None:
        raise Validation("订单未关联库存账号", details={"order_id": order_id})
    account = db.scalar(select(Account).where(Account.id == order.account_id).with_for_update().execution_options(populate_existing=True))
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

    payload = prepare_cashflow_event_edits(db, order_id, payload, user)
    lock_edit_pools(db, order_id, payload, user)
    # 先平移订单日期及其关联账期，再应用本次对具体事件、流水的明确修改。
    apply_order_edits(db, account.id, order_id, payload.orders, user)
    if payload.orders:
        db.flush()
    event_changes, cost_delta = validate_event_edits(db, account, order_id, payload, user)
    if payload.profile is not None:
        profile = payload.profile.model_dump(exclude_unset=True)
        if payload.expected_profile is not None:
            profile = _checked_profile(account, profile, payload.expected_profile)
            if "form_extra" not in profile and profile.keys() - {"account_description", "account_images"}:
                changed_extras = profile.get("extra_values") or {}
                profile["form_extra"] = {key: value for key, value in (account.form_extra or {}).items() if key not in changed_extras}
        if profile.keys() - {"account_description", "account_images"}:
            profile.setdefault("form_extra", {})
        update_account_profile(
            db,
            account.id,
            actor=user.username,
            user=user,
            **profile,
        )
    elif payload.expected_profile is not None:
        raise Validation("账号资料的并发检查缺少修改内容")
    apply_event_edits(db, event_changes, user.username)
    apply_operation_event_creates(db, order_id, payload.new_events, user.username, user)
    if payload.cashflows:
        db.flush()
    apply_cashflow_edits(db, account.id, order, payload.cashflows, user)
    apply_party_edits(db, account.id, order, payload.parties, user)

    account.cost_amount = Decimal(str(account.cost_amount)) + cost_delta
    if event_changes:
        account.updated_by = user.username
    db.flush()
