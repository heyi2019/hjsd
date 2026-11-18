"""orders.router_outputs.list_payload：订单列表摘要装配。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.money import to_money
from app.domain.enums import AccountingAttribute, CashflowSourceType, Direction
from app.domain.parties import (
    Counterparty,
    Customer,
    OrderCounterpartyRole,
    OrderCustomerRole,
)
from app.domain.trade import Account, Cashflow, Installment, OrderEvent
from app.domain.users import User
from app.orders.output_labels import _elapsed_label, _form_responsible_label, _selected_operator_label
from app.shared.order_amounts import ZERO, event_totals, order_cashflow_profit_by_order
from app.orders.router_outputs._shared import _operator_names, _sale_amount


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
    # （初始费用仅回收/提号订单可提交，DG 无初始成本；此处只需识别两种直接成本属性。）
    unlinked_cost_by_order = {
        order_id: to_money(total or 0)
        for order_id, total in db.execute(
            select(Cashflow.order_id, func.coalesce(func.sum(Cashflow.amount), 0))
            .where(
                Cashflow.order_id.in_(order_ids),
                Cashflow.source_type != CashflowSourceType.ORDER_EVENT.value,
                Cashflow.direction == Direction.OUT.value,
                Cashflow.accounting_attribute.in_(
                    (
                        AccountingAttribute.SELF_DIRECT_COST.value,
                        AccountingAttribute.TH_DIRECT_COST.value,
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
        sale_operator = (_selected_operator_label(sale_event, operator_names) or None) if sale_event else None
        inventory_entry_at = account.inventory_entry_at if account else None
        payloads.append({
            "id": order.id,
            "order_no": order.order_no,
            "order_type": order.order_type,
            "trade_date": order.trade_date,
            "account_id": order.account_id,
            "status": order.status,
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
