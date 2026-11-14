"""orders.mutations：订单更新与取消（ORD-02）。

状态流转走 `ORDER_TRANSITIONS`，取消不物理删除，保留事件与审计；物理删除见 `orders.deletion`。
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date, timedelta
from typing import Any
from app.core.audit import record_audit
from app.core.security import CurrentUser
from app.foundation.order_types import get_order_type_by_code
from app.orders.form_fields import validate_form_extra
from app.parties.fields import set_extra_values
from app.policy import versions as policy_versions
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import Validation
from app.domain.trade import (
    Account,
    Cashflow,
    Installment,
    InstallmentDisposition,
    Order,
    OrderEvent,
    RebateRecord,
    Reconciliation,
)
from app.domain.enums import (
    AuditAction,
    OrderStatus,
    PolicyType,
)

from ._shared import _audit_value, get_order

_UNSET = object()


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

    # #14 对账边界：平移会改动流水的 occurred_on；若任一流水所属资金池在
    # 「该流水旧日期→新日期」移动区间内已有对账快照（含 OPEN/RESOLVED，对账一旦
    # 建立即固化当日余额），平移会把流水挪进/挪出已对账期间，破坏快照，必须拒绝。
    # 用流水实际日期区间而非 trade_date：买入/收款常发生在成交日之前，区间更宽。
    if delta != 0 and flows:
        dated = [(f.pool_id, f.occurred_on) for f in flows if f.pool_id is not None and f.occurred_on is not None]
        for pool_id, old_on in dated:
            new_on = old_on + shift
            lo, hi = sorted((old_on, new_on))
            locked = session.scalars(
                select(Reconciliation.id).where(
                    Reconciliation.pool_id == pool_id,
                    Reconciliation.reconciled_on >= lo,
                    Reconciliation.reconciled_on <= hi,
                )
            ).first()
            if locked is not None:
                raise Validation(
                    "成交日期涉及资金池已对账期间，不能平移账期",
                    details={"from": order.trade_date.isoformat(), "to": new_trade_date.isoformat()},
                )

    for event in events:
        event.occurred_on = event.occurred_on + shift
        event.updated_by = actor
    for flow in flows:
        flow.occurred_on = flow.occurred_on + shift
        flow.updated_by = actor

    # #6 分期坏账按回收处置日（InstallmentDisposition.occurred_on）归期；
    # 只平移事件与流水会让坏账留在旧月份，跨期口径撕裂。
    dispositions = session.scalars(
        select(InstallmentDisposition)
        .join(Installment, Installment.id == InstallmentDisposition.installment_id)
        .where(Installment.order_id == order.id)
    ).all()
    for disposition in dispositions:
        if disposition.occurred_on is not None:
            disposition.occurred_on = disposition.occurred_on + shift
            disposition.updated_by = actor

    # #7 旧模型返点按 collected_on 归期；新模型返点走 REBATE 事件
    # （已在上面 events 平移），此处覆盖旧模型无事件的返点记录。
    rebates = session.scalars(
        select(RebateRecord).where(RebateRecord.source_order_id == order.id)
    ).all()
    for rebate in rebates:
        if rebate.collected_on is not None:
            rebate.collected_on = rebate.collected_on + shift
            rebate.updated_by = actor

    # #18 账号 buy_date 在 BUY 时被置为 order.trade_date（events_rules._apply_account_effect），
    # 成交日期平移后须同步，否则账号台账「买入日期」与订单成交日期脱节。
    # 只在「本单确有已过账 BUY 事件」时同步：同一账号的 SELL 单平移不应改动买入日期。
    has_posted_buy = any(
        e.event_type == "BUY" and e.is_posted for e in events
    )
    if order.account_id is not None and delta != 0 and has_posted_buy:
        account = session.get(Account, order.account_id)
        if account is not None and account.buy_date is not None:
            account.buy_date = account.buy_date + shift
            account.updated_by = actor

    definition = get_order_type_by_code(session, order.order_type)
    if definition is not None:
        snapshot: dict[str, Any] = {}
        primary_version_id: int | None = None
        for code in (PolicyType.REBATE.value, PolicyType.COMMISSION.value):
            version_id, snap = policy_versions.make_snapshot(
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
        "shifted_bad_debts": len(dispositions),
        "shifted_rebates": len(rebates),
    }


def update_order(
    session: Session,
    order_id: int,
    *,
    actor: str,
    trade_date: date | None | object = _UNSET,
    account_snapshot: dict[str, Any] | None | object = _UNSET,
    note: str | None | object = _UNSET,
    extra_values: Mapping[str, Any] | None | object = _UNSET,
    form_extra: Mapping[str, Any] | None | object = _UNSET,
    user: CurrentUser | None = None,
) -> Order:
    """受控编辑订单主字段。

    成交日期随时可改：改日期时按天数差平移本单全部事件与资金流水的 occurred_on，
    并按新成交日重取返点/提成规则快照，保证账期与规则口径一致。
    账号快照、订单编号、业务类型、库存账号关联和状态仍属不可编辑字段。
    """
    order = get_order(session, order_id, user)
    if trade_date is not _UNSET and trade_date is None:
        raise Validation("订单日期不能清空", details={"field": "trade_date"})
    # trade_date 已放开：不再受「已有登记事件」限制，改日期在下方联动平移账期。
    accounting_changes = (account_snapshot,)
    if any(value is not _UNSET for value in accounting_changes):
        posted = session.scalar(
            select(OrderEvent.id).where(
                OrderEvent.order_id == order.id,
                OrderEvent.is_posted.is_(True),
            )
        )
        if posted is not None:
            raise Validation("已有登记事件的订单不能修改账号快照，核算数据须通过冲销/更正")

    if account_snapshot is not _UNSET and account_snapshot is not None:
        raise Validation("订单账号快照当前不支持")

    before = {
        "trade_date": order.trade_date,
        "account_snapshot": order.account_snapshot,
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
    if account_snapshot is not _UNSET:
        order.account_snapshot = account_snapshot
    if note is not _UNSET:
        order.note = note
    order.updated_by = actor
    session.flush()
    if extra_values is not _UNSET:
        set_extra_values(
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
            "note": order.note,
            "policy_version_id": order.policy_version_id,
            **shift_info,
        }),
    )
    return order
