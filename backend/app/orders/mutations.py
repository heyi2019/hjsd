"""orders.mutations：订单更新与取消（ORD-02）。

状态流转走 `ORDER_TRANSITIONS`，取消不物理删除，保留事件与审计。
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date, datetime, timedelta
from typing import Any
from app.core.audit import record_audit
from app.core.security import CurrentUser
from app.foundation import service as foundation_service
from app.orders.form_fields import validate_form_extra
from app.parties import service as parties_service
from app.policy import service as policy_service
from app.stocks import service as stocks_service
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import Validation
from app.domain.trade import (
    Cashflow,
    Order,
    OrderEvent,
)
from app.domain.enums import (
    AuditAction,
    OrderStatus,
    PolicyType,
)

from ._shared import (
    _audit_value,
    get_order,
)

_UNSET = object()


def materialize_inventory_account(
    session: Session,
    order_id: int,
    *,
    actor: str,
    user: CurrentUser | None = None,
) -> Order:
    """为历史未关联库存的进行中订单补建库存实体。

    只接受仍在进行中的 HS/TH/DG 订单，并且必须已有完整账号快照；
    不为缺少账号资料的历史行凭空生成库存编号。
    """
    order = get_order(session, order_id, user)
    if order.account_id is not None:
        return order
    if order.status not in {OrderStatus.ACTIVE.value, OrderStatus.INSTALLMENT.value}:
        raise Validation("只有进行中的订单可以补建库存账号", details={"order_id": order_id})
    context = {
        "HS": ("SELF", "RECOVERY"),
        "TH": ("DISTRIBUTION", "PICKUP"),
        "DG": ("DISTRIBUTION", "CONSIGNMENT"),
    }.get(order.order_type)
    if context is None:
        raise Validation("当前订单类型不支持补建库存账号", details={"order_type": order.order_type})
    snapshot = order.account_snapshot or {}
    game_account = snapshot.get("game_account")
    if not isinstance(game_account, str) or not game_account.strip():
        raise Validation(
            "订单缺少游戏账号资料，无法生成库存编号",
            details={"field": "account_snapshot.game_account", "order_id": order_id},
        )
    business_mode, inventory_type = context
    account = stocks_service.create_account(
        session,
        game_account=game_account,
        actor=actor,
        game_type=snapshot.get("game_type"),
        business_mode=business_mode,
        inventory_type=inventory_type,
        game_password=snapshot.get("game_password"),
        camp_account=snapshot.get("camp_account"),
        channel_region=snapshot.get("channel_region"),
        bound_phone=snapshot.get("bound_phone"),
        has_secondary=snapshot.get("has_secondary"),
        secondary_images=snapshot.get("secondary_images"),
        wallet_realname=snapshot.get("wallet_realname"),
        wallet_realname_images=snapshot.get("wallet_realname_images"),
        platform=snapshot.get("platform"),
        note=snapshot.get("note"),
        extra_values=snapshot.get("extra_values"),
    )
    if order.created_at is not None:
        account.inventory_entry_at = order.created_at.replace(microsecond=0)
    order.account_id = account.id
    order.updated_by = actor
    session.flush()
    return order


def _shift_accounting_dates(
    session: Session,
    order: Order,
    *,
    actor: str,
    new_trade_date: date,
) -> dict[str, int]:
    """成交日期变更时按天数差平移账期，并按新成交日重取规则快照。

    用「天数差」而不是把每个 occurred_on 统一改成新日期：保留事件之间的相对
    时间关系（成交日后第 3 天的收款，改日期后仍是第 3 天）。
    分期合约的 first_due_on / 期次 due_on 属客户还款计划，不随单据日期平移。
    """
    delta = (new_trade_date - order.trade_date).days
    shift = timedelta(days=delta)
    events = session.scalars(
        select(OrderEvent).where(OrderEvent.order_id == order.id)
    ).all()
    flows = session.scalars(
        select(Cashflow).where(Cashflow.order_id == order.id)
    ).all()
    for event in events:
        event.occurred_on = event.occurred_on + shift
        event.updated_by = actor
    for flow in flows:
        flow.occurred_on = flow.occurred_on + shift
        flow.updated_by = actor

    definition = foundation_service.get_order_type_by_code(session, order.order_type)
    if definition is not None:
        snapshot: dict[str, Any] = {}
        primary_version_id: int | None = None
        for code in (PolicyType.REBATE.value, PolicyType.COMMISSION.value):
            version_id, snap = policy_service.make_snapshot(
                session,
                policy_code=code,
                on=new_trade_date,
                scope_type="ORDER_TYPE",
                scope_id=definition.id,
            )
            if snap is None:
                continue
            snapshot[code] = snap
            if primary_version_id is None:
                primary_version_id = version_id
        order.policy_version_id = primary_version_id
        order.policy_snapshot = snapshot or None
    return {
        "shifted_days": delta,
        "shifted_events": len(events),
        "shifted_cashflows": len(flows),
    }


def update_order(
    session: Session,
    order_id: int,
    *,
    actor: str,
    trade_date: date | None | object = _UNSET,
    account_snapshot: dict[str, Any] | None | object = _UNSET,
    created_at: datetime | None | object = _UNSET,
    note: str | None | object = _UNSET,
    extra_values: Mapping[str, Any] | None | object = _UNSET,
    form_extra: Mapping[str, Any] | None | object = _UNSET,
    user: CurrentUser | None = None,
) -> Order:
    """受控编辑订单主字段。

    成交日期随时可改：改日期时按天数差平移本单全部事件与资金流水的 occurred_on，
    并按新成交日重取返点/提成规则快照，保证账期与规则口径一致。
    账号快照（可编辑）、
    登记时间（created_at，可改可清空）均在此开放；订单编号、业务类型、
    库存账号关联和状态仍属不可编辑字段。
    """
    order = get_order(session, order_id, user)
    if trade_date is not _UNSET and trade_date is None:
        raise Validation("订单日期不能清空", details={"field": "trade_date"})
    # trade_date 已放开：不再受「已有登记事件」限制，改日期在下方联动平移账期。
    # account_snapshot 可编辑，保留订单自身快照。
    # 不再因「已有登记事件」而拒绝；核算口径如需修正走冲销/更正，但快照文本本身可改。

    before = {
        "trade_date": order.trade_date,
        "account_snapshot": order.account_snapshot,
        "created_at": order.created_at,
        "note": order.note,
        "policy_version_id": order.policy_version_id,
    }
    shift_info: dict[str, int] = {}
    if trade_date is not _UNSET and trade_date != order.trade_date:
        shift_info = _shift_accounting_dates(
            session, order, actor=actor, new_trade_date=trade_date  # type: ignore[arg-type]
        )
    if trade_date is not _UNSET:
        order.trade_date = trade_date
    if created_at is not _UNSET:
        order.created_at = created_at
    if account_snapshot is not _UNSET:
        order.account_snapshot = account_snapshot
    if note is not _UNSET:
        order.note = note
    order.updated_by = actor
    session.flush()
    if extra_values is not _UNSET:
        parties_service.set_extra_values(
            session,
            entity_type="order",
            entity_id=order.id,
            values=(extra_values or {}).items(),
        )
    if form_extra is not _UNSET and form_extra:
        # ORDEREDIT 作用域自定义字段值合并进订单 form_extra。
        checked = validate_form_extra(session, order_type_code="ORDEREDIT", values=form_extra)
        order.form_extra = {**(order.form_extra or {}), **checked}
    record_audit(
        session,
        action=AuditAction.ORDER_UPDATE,
        entity_type="order",
        entity_id=order.order_no,
        actor=actor,
        before=_audit_value(before),
        after=_audit_value({
            "trade_date": order.trade_date,
            "account_snapshot": order.account_snapshot,
            "created_at": order.created_at,
            "note": order.note,
            "policy_version_id": order.policy_version_id,
            **shift_info,
        }),
    )
    return order
