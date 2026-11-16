"""orders.router_output：订单/事件接口的输出装配（列表、详情、操作人标签）。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from decimal import Decimal

from app.core.money import to_money, to_money_or_zero
from app.core.security import (
    CurrentUser,
    PERM_AUDIT_READ,
    PERM_FINANCE_READ,
)
from app.domain.enums import AccountingAttribute, Direction
from app.domain.attachments import Attachment
from app.domain.foundation import AuditLog
from app.domain.parties import (
    Counterparty,
    Customer,
    OrderCounterpartyRole,
    OrderCustomerRole,
)
from app.domain.trade import (
    Account,
    Cashflow,
    Installment,
    InstallmentSchedule,
    Order,
    OrderEvent,
    RebateRecord,
)
from app.domain.users import User
from app.orders import schemas
from app.orders.links import list_order_links
from app.orders.amounts import ZERO, event_totals, order_cashflow_profit_by_order
from .output_labels import _elapsed_label, _form_responsible_label, _selected_operator_label
from app.core.actor import actor_name as _actor


def _apply_common_output(output, order):
    """回显订单表单扩展值与账号快照。"""
    # 表单字段自定义值落订单 form_extra 列，读取直接回显（BAS-04-03 历史值可查）。
    output.extra_values = dict(order.form_extra or {})
    return output


def _order_output(order) -> schemas.OrderOut:
    """输出订单详情。"""
    output = schemas.OrderOut.model_validate(order)
    return _apply_common_output(output, order)


def _operator_names(db: Session, events: list[OrderEvent]) -> dict[int, str]:
    ids = {user_id for event in events for user_id in (event.operator_user_ids or [])}
    if not ids:
        return {}
    users = db.scalars(select(User).where(User.id.in_(ids))).all()
    return {user.id: user.display_name or user.username for user in users}


def _sale_amount(order_type: str, events: list[OrderEvent]) -> Decimal | None:
    """列表展示的售出金额：只取 SELL，不把 BUY 成本合进来。"""
    sell_events = [event for event in events if event.event_type == "SELL"]
    if not sell_events:
        return None
    if order_type == "DG":
        recorded = [
            to_money_or_zero((event.form_extra or {}).get("sale_amount"))
            for event in sell_events
            if (event.form_extra or {}).get("sale_amount") not in (None, "")
        ]
        if recorded:
            return sum(recorded, ZERO)
    return sum((to_money(event.amount) for event in sell_events), ZERO)


def cancellable_by_event(events: list[OrderEvent]) -> dict[int, Decimal]:
    """每个事件的可冲销余额：`amount − Σ已冲销 CANCEL`，夹底 0；CANCEL 自身恒 0。

    与 `post_event` 的冲销校验同源（校验挡住超额，这里给前端展示「还能冲多少」）。
    一次遍历累加 CANCEL 再逐事件相减，避免每个事件回查一遍。
    """
    cancelled: dict[int, Decimal] = {}
    for item in events:
        if item.event_type == "CANCEL" and item.offset_event_id is not None:
            cancelled[item.offset_event_id] = cancelled.get(item.offset_event_id, Decimal("0.00")) + to_money(item.amount)
    amounts: dict[int, Decimal] = {}
    for item in events:
        if item.event_type == "CANCEL":
            amounts[item.id] = Decimal("0.00")
            continue
        remaining = to_money(item.amount) - cancelled.get(item.id, Decimal("0.00"))
        amounts[item.id] = remaining if remaining > 0 else Decimal("0.00")
    return amounts


def _event_output(
    event: OrderEvent,
    operator_names: dict[int, str] | None = None,
    cancellable: dict[int, Decimal] | None = None,
) -> schemas.EventOut:
    """把审计字段映射为事件响应字段，避免 ORM 属性名泄漏到 API。"""
    selected_operators = _selected_operator_label(event, operator_names)
    return schemas.EventOut.model_validate(
        {
            "id": event.id,
            "event_no": event.event_no,
            "order_id": event.order_id,
            "event_type": event.event_type,
            "sale_mode": (event.form_extra or {}).get("sale_mode"),
            "operation_type": (event.form_extra or {}).get("operation_type"),
            "rebate_type": (event.form_extra or {}).get("rebate_type"),
            "amount": event.amount,
            "occurred_on": event.occurred_on,
            "pool_id": event.pool_id,
            "offset_event_id": event.offset_event_id,
            "portion": event.portion,
            "delivery_mode": event.delivery_mode,
            "delivery_direction": (event.form_extra or {}).get("delivery_direction"),
            "is_posted": event.is_posted,
            "posted_at": event.posted_at,
            "reason": event.reason,
            "operator_user_ids": event.operator_user_ids,
            "note": event.note,
            "form_extra": event.form_extra,
            "created_at": event.created_at,
            # created_by 是审计操作者；业务上的操作人以表单勾选员工为准。
            "operator": selected_operators or event.created_by,
            "cancellable_amount": (cancellable or {}).get(event.id, Decimal("0.00")),
        }
    )


def _order_detail_output(
    db: Session, order, user: CurrentUser
) -> schemas.OrderDetailOut:
    """订单详情统一返回主字段和执行事件，避免前端再拼接隐式查询。"""
    output = schemas.OrderDetailOut.model_validate(order)
    _apply_common_output(output, order)
    events = db.scalars(
        select(OrderEvent)
        .where(OrderEvent.order_id == order.id)
        .order_by(OrderEvent.occurred_on, OrderEvent.id)
    ).all()
    operator_names = _operator_names(db, events)
    event_by_id = {event.id: event for event in events}
    cancellable = cancellable_by_event(list(events))
    output.events = [_event_output(event, operator_names, cancellable) for event in events]
    output.links = [
        schemas.OrderLinkOut.model_validate(item)
        for item in list_order_links(db, order.id, user)
    ]
    if user.has(PERM_FINANCE_READ):
        cashflows = db.scalars(
            select(Cashflow)
            .where(Cashflow.order_id == order.id)
            .order_by(Cashflow.occurred_on, Cashflow.id)
        ).all()
        output.cashflows = [
            schemas.OrderCashflowOut.model_validate(
                {
                    "flow_no": item.flow_no,
                    "pool_id": item.pool_id,
                    "occurred_on": item.occurred_on,
                    "nature": item.nature,
                    "category": item.category,
                    "direction": item.direction,
                    "amount": item.amount,
                    "status": item.status,
                    "order_event_id": item.order_event_id,
                    "note": item.note,
                    "operator": _selected_operator_label(event_by_id.get(item.order_event_id), operator_names)
                    or item.created_by,
                }
            )
            for item in cashflows
        ]
        rebates = db.scalars(
            select(RebateRecord)
            .where(RebateRecord.source_order_id == order.id)
            .order_by(RebateRecord.id)
        ).all()
        output.rebates = [
            schemas.OrderRebateOut.model_validate(
                {
                    "id": item.id,
                    "rebate_no": item.rebate_no,
                    "rebate_type": item.rebate_type,
                    "channel": item.channel,
                    "amount": item.amount,
                    "link_status": item.link_status,
                    "status": item.status,
                    "collected_on": item.collected_on,
                    "note": item.note,
                    "created_at": item.created_at,
                    "operator": item.created_by,
                }
            )
            for item in rebates
        ]
    installment = db.scalar(
        select(Installment).where(Installment.order_id == order.id)
    )
    if installment is not None:
        output.installment = schemas.OrderInstallmentOut.model_validate(installment)
        schedules = db.scalars(
            select(InstallmentSchedule)
            .where(InstallmentSchedule.installment_id == installment.id)
            .order_by(InstallmentSchedule.period_no)
        ).all()
        output.installment_schedule = [
            schemas.OrderScheduleOut.model_validate(item) for item in schedules
        ]
    attachment_refs = [("order", order.order_no)]
    attachment_refs.extend(("order_event", event.event_no) for event in events)
    if installment is not None:
        attachment_refs.append(("installment", installment.inst_no))
    if user.has(PERM_FINANCE_READ):
        attachment_refs.extend(("cashflow", item.flow_no) for item in cashflows)
    if attachment_refs:
        output.attachments = [
            schemas.AttachmentOut.model_validate(item)
            for item in db.scalars(
                select(Attachment)
                .where(
                    Attachment.deleted_at.is_(None),
                    or_(*(
                        (Attachment.entity_type == entity_type)
                        & (Attachment.entity_id == entity_id)
                        for entity_type, entity_id in attachment_refs
                    )),
                )
                .order_by(Attachment.created_at, Attachment.id)
            ).all()
        ]
    if user.has(PERM_AUDIT_READ):
        audit_rows = db.scalars(
            select(AuditLog)
            .where(
                AuditLog.entity_type == "order",
                AuditLog.entity_id == order.order_no,
            )
            .order_by(AuditLog.id)
        ).all()
        output.audit = [
            schemas.OrderAuditOut.model_validate(
                {
                    "id": item.id,
                    "action": item.action,
                    "entity_type": item.entity_type,
                    "entity_id": item.entity_id,
                    "actor": item.actor,
                    "reason": item.reason,
                    "request_id": item.request_id,
                    "occurred_at": item.occurred_at,
                }
            )
            for item in audit_rows
        ]
    return output


def _order_list_payload(db: Session, orders: list) -> list[dict]:
    """组装工作台摘要，避免列表页为每一行再请求详情。"""
    # 表单字段自定义值落订单 form_extra 列，列表直接从行数据回显。
    extra_values = {
        item.id: dict(item.form_extra or {}) for item in orders
    }
    order_ids = [item.id for item in orders]
    cashflow_profits = order_cashflow_profit_by_order(db, order_ids=order_ids)
    account_ids = [item.account_id for item in orders if item.account_id is not None]
    accounts = (
        {item.id: item for item in db.scalars(select(Account).where(Account.id.in_(account_ids))).all()}
        if account_ids else {}
    )
    # 账号和订单一对一，当前列表中的订单就是账号来源，无须再按 account_id 回查订单表。
    source_orders_by_account = {
        order.account_id: order
        for order in orders
        if order.account_id is not None
    }
    inventory_responsible_ids = {
        item
        for source_order in source_orders_by_account.values()
        for item in ((source_order.form_extra or {}).get("business_responsible_ids") or [])
        if isinstance(item, int) and item > 0
    }
    inventory_operator_names = {
        item.id: item.display_name or item.username
        for item in db.scalars(select(User).where(User.id.in_(inventory_responsible_ids))).all()
    } if inventory_responsible_ids else {}

    parties: dict[int, tuple[str, str, str | None, str, datetime]] = {}
    if order_ids:
        for role, customer in db.execute(
            select(OrderCustomerRole, Customer)
            .join(Customer, Customer.id == OrderCustomerRole.customer_id)
            .where(OrderCustomerRole.order_id.in_(order_ids))
        ).all():
            parties.setdefault(role.order_id, (customer.display_name, role.role, customer.source, customer.created_by, customer.created_at))
        for role, counterparty in db.execute(
            select(OrderCounterpartyRole, Counterparty)
            .join(Counterparty, Counterparty.id == OrderCounterpartyRole.counterparty_id)
            .where(OrderCounterpartyRole.order_id.in_(order_ids))
        ).all():
            parties.setdefault(role.order_id, (counterparty.display_name, role.role, counterparty.source, counterparty.created_by, counterparty.created_at))

    events_by_order: dict[int, list[OrderEvent]] = {}
    if order_ids:
        for event in db.scalars(
            select(OrderEvent)
            .where(OrderEvent.order_id.in_(order_ids), OrderEvent.is_posted.is_(True))
            .order_by(OrderEvent.occurred_on.desc(), OrderEvent.id.desc())
        ).all():
            events_by_order.setdefault(event.order_id, []).append(event)

    # 订单初始费用是资金明细，不生成额外业务事件。
    # 只取未关联业务事件的成本流水，避免把业务事件派生流水重复计入。
    unlinked_cost_by_order = {
        order_id: to_money(total or 0)
        for order_id, total in db.execute(
            select(Cashflow.order_id, func.coalesce(func.sum(Cashflow.amount), 0))
            .where(
                Cashflow.order_id.in_(order_ids),
                Cashflow.order_event_id.is_(None),
                Cashflow.direction == Direction.OUT.value,
                Cashflow.accounting_attribute.in_(
                    (
                        AccountingAttribute.SELF_DIRECT_COST.value,
                        AccountingAttribute.TH_DIRECT_COST.value,
                        AccountingAttribute.DG_DIRECT_COST.value,
                    )
                ),
            )
            .group_by(Cashflow.order_id)
        ).all()
    } if order_ids else {}

    operator_names = _operator_names(
        db,
        [event for events in events_by_order.values() for event in events],
    )

    installments = (
        {item.order_id: item for item in db.scalars(select(Installment).where(Installment.order_id.in_(order_ids))).all()}
        if order_ids else {}
    )

    payloads: list[dict] = []
    for order in orders:
        account = accounts.get(order.account_id)
        snapshot = order.account_snapshot or {}
        events = events_by_order.get(order.id, [])
        installment = installments.get(order.id)
        income, event_cost, additional_cost = event_totals(events)
        total_cost = event_cost + additional_cost + unlinked_cost_by_order.get(order.id, ZERO)
        latest = events[0] if events else None
        sale_event = next((event for event in events if event.event_type == "SELL"), None)
        party = parties.get(order.id)
        installment = installments.get(order.id)
        # 售卖时间取卖出事件的业务发生日（occurred_on），不用记录创建时刻 created_at；
        # created_at 是入库写入时间，用它会让历史导入单全部显示成导入当天。
        sale_at = (
            datetime.combine(sale_event.occurred_on, datetime.min.time())
            if sale_event
            else installment.created_at if installment else None
        )
        sale_operator = (
            (_selected_operator_label(sale_event, operator_names) or sale_event.created_by)
            if sale_event else installment.created_by if installment else None
        )
        inventory_entry_at = account.inventory_entry_at if account else None
        payloads.append({
            "id": order.id,
            "order_no": order.order_no,
            "order_type": order.order_type,
            "capital_type": order.capital_type,
            "trade_date": order.trade_date,
            "account_id": order.account_id,
            "status": order.status,
            "link_status": order.link_status,
            "owner_id": order.owner_id,
            "note": order.note,
            "extra_values": extra_values.get(order.id, {}),
            "created_at": order.created_at,
            # HS / TH / DG 从库存实体展示安全的业务字段，
            # 不把快照中的 game_password 原样带入列表响应。
            "stock_no": account.stock_no if account else None,
            "account_game_type": (account.game_type if account else None) or snapshot.get("game_type"),
            "account_game_account": (account.game_account if account else None) or snapshot.get("game_account"),
            "account_channel_region": (account.channel_region if account else None) or snapshot.get("channel_region"),
            "account_business_mode": account.business_mode if account else None,
            "account_platform": account.platform if account else snapshot.get("platform"),
            "account_status": account.status if account else None,
            "party_name": party[0] if party else None,
            "party_role": party[1] if party else None,
            "party_source": party[2] if party else None,
            "party_created_by": party[3] if party else None,
            "party_created_at": party[4] if party else None,
            "inventory_entry_at": inventory_entry_at,
            "inventory_operator": (
                _form_responsible_label(
                    source_orders_by_account.get(account.id).form_extra if account and source_orders_by_account.get(account.id) else None,
                    inventory_operator_names,
                    None,
                )
                if account else None
            ),
            "sale_at": sale_at,
            "sale_operator": sale_operator,
            "in_hand_time": _elapsed_label(inventory_entry_at, sale_at),
            "sale_amount": _sale_amount(order.order_type, events),
            "cost_amount": total_cost,
            # 台账利润与利润分配、报表共用现金流口径：所有收入 − 所有支出，
            # 收入含返点，支出含分期坏账；不能再用 SELL/BUY/COST 事件推导。
            "profit_base": cashflow_profits.get(order.id, ZERO),
            "last_event_type": latest.event_type if latest else None,
            "last_event_amount": latest.amount if latest else None,
            "last_event_on": latest.occurred_on if latest else None,
            "installment_principal": installment.principal if installment else None,
            "installment_paid": installment.paid_amount if installment else None,
            "installment_periods": installment.periods if installment else None,
            "installment_status": installment.status if installment else None,
        })
    return payloads

__all__ = [
    "_actor",
    "_order_output",
    "_operator_names",
    "_event_output",
    "_selected_operator_label",
    "_order_detail_output",
    "_order_list_payload",
]
