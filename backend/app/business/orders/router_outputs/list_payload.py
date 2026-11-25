"""business.orders.router_outputs.list_payload：订单列表摘要装配。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.domain.parties import (
    Counterparty,
    Customer,
    OrderCounterpartyRole,
    OrderCustomerRole,
)
from app.domain.trade import Account, Installment
from app.domain.users import User
from app.shared.option_snapshots import option_label_maps
from app.business.inventory.collaboration import register_order_list_payload_builder
from app.business.orders.output_labels import _elapsed_label, _form_responsible_label, _selected_operator_label
from app.business.orders.amount_summaries import order_amount_summaries
from app.business.orders.router_outputs._shared import _operator_names


def _order_list_payload(db: Session, orders: list, *, accounts: list[Account] | None = None) -> list[dict]:
    """组装工作台摘要，避免列表页为每一行再请求详情。"""
    order_ids = [item.id for item in orders]
    amount_summaries, events_by_order = order_amount_summaries(db, orders)
    account_ids = [item.account_id for item in orders if item.account_id is not None]
    accounts_by_id = (
        {item.id: item for item in accounts}
        if accounts is not None
        else {
            item.id: item for item in db.execute(
                select(Account.id, Account.stock_no, Account.game_type, Account.game_account,
                       Account.channel_region, Account.business_mode, Account.status, Account.inventory_entry_at,
                       Account.form_extra)
                .where(Account.id.in_(account_ids))
            ).all()
        }
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
        for source_order in orders
        for item in ((source_order.form_extra or {}).get("business_responsible_ids") or [])
        if isinstance(item, int) and item > 0
    }
    inventory_operator_names = {
        item.id: item.display_name or item.username
        for item in db.scalars(select(User).where(User.id.in_(inventory_responsible_ids))).all()
    } if inventory_responsible_ids else {}

    parties: dict[int, tuple[str, str, str | None, str, datetime, str, int]] = {}
    if order_ids:
        for order_id, role, name, source, created_by, created_at, participant_id in db.execute(
            select(OrderCustomerRole.order_id, OrderCustomerRole.role, Customer.display_name,
                   Customer.source, Customer.created_by, Customer.created_at, Customer.id)
            .join(Customer, Customer.id == OrderCustomerRole.customer_id)
            .where(OrderCustomerRole.order_id.in_(order_ids))
        ).all():
            parties.setdefault(order_id, (name, role, source, created_by, created_at, "customer", participant_id))
        for order_id, role, name, source, created_by, created_at, participant_id in db.execute(
            select(OrderCounterpartyRole.order_id, OrderCounterpartyRole.role, Counterparty.display_name,
                   Counterparty.source, Counterparty.created_by, Counterparty.created_at, Counterparty.id)
            .join(Counterparty, Counterparty.id == OrderCounterpartyRole.counterparty_id)
            .where(OrderCounterpartyRole.order_id.in_(order_ids))
        ).all():
            parties.setdefault(order_id, (name, role, source, created_by, created_at, "counterparty", participant_id))
    source_labels = option_label_maps(db, {"CUSTOMER_SOURCE", "SUPPLIER_SOURCE"}) if parties else {}

    operator_names = _operator_names(
        db,
        [event for events in events_by_order.values() for event in events],
    )

    installments = {
        item.order_id: item
        for item in db.execute(
            select(Installment.order_id, Installment.principal, Installment.paid_amount,
                   Installment.periods, Installment.status, Installment.created_at)
            .where(Installment.id.in_(
                select(func.max(Installment.id))
                .where(Installment.order_id.in_(order_ids))
                .group_by(Installment.order_id)
            ))
        ).all()
    } if order_ids else {}

    payloads: list[dict] = []
    for order in orders:
        account = accounts_by_id.get(order.account_id)
        snapshot = order.account_snapshot or {}
        account_values = account.form_extra if account else snapshot.get("extra_values")
        # 账号字段以当前库存为准；未绑定库存的导入订单从订单快照读取。
        extra_values = {
            **(order.form_extra or {}),
            **(account_values if isinstance(account_values, dict) else {}),
        }
        option_snapshot = dict(order.option_label_snapshot or {})
        for key, value in (order.form_extra or {}).items():
            if extra_values.get(key) != value:
                option_snapshot.pop(key, None)
        events = events_by_order.get(order.id, [])
        installment = installments.get(order.id)
        amounts = amount_summaries[order.id]
        latest = events[0] if events else None
        sale_events = [event for event in events if event.event_type == "SELL"]
        sale_event = (
            max(sale_events, key=lambda event: event.id)
            if sale_events and order.order_type in {"HS", "TH"}
            else next(iter(sale_events), None)
        )
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
            "extra_values": extra_values,
            "option_label_snapshot": option_snapshot or None,
            "created_at": order.created_at,
            # HS / TH / DG 从库存实体展示安全的业务字段，
            # 不把快照中的 game_password 原样带入列表响应。
            "stock_no": account.stock_no if account else None,
            "account_game_type": (account.game_type if account else None) or snapshot.get("game_type"),
            "account_game_type_label": snapshot.get("game_type_label") if not account or not account.game_type or account.game_type == snapshot.get("game_type") else None,
            "account_game_account": (account.game_account if account else None) or snapshot.get("game_account"),
            "account_channel_region": (account.channel_region if account else None) or snapshot.get("channel_region"),
            "account_channel_region_label": snapshot.get("channel_region_label") if not account or not account.channel_region or account.channel_region == snapshot.get("channel_region") else None,
            "account_business_mode": account.business_mode if account else None,
            "account_status": account.status if account else None,
            "party_name": party[0] if party else None,
            "party_role": party[1] if party else None,
            "party_source": party[2] if party else None,
            "party_source_label": (
                (order.option_label_snapshot or {}).get(f"party_source:{party[5]}:{party[6]}")
                or source_labels.get(("CUSTOMER_SOURCE" if party[5] == "customer" else "SUPPLIER_SOURCE", party[2]), party[2])
            ) if party and party[2] else None,
            "party_created_by": party[3] if party else None,
            "party_created_at": party[4] if party else None,
            "inventory_entry_at": inventory_entry_at,
            "business_operator": _form_responsible_label(order.form_extra, inventory_operator_names, None),
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
            "sale_amount": amounts.sale_amount,
            "cost_amount": amounts.cost_amount,
            # 台账利润与利润分配、报表共用现金流口径：所有收入 − 所有支出，
            # 收入含返点，支出含分期坏账；不能再用 SELL/BUY/COST 事件推导。
            "profit_base": amounts.profit_base,
            "last_event_type": latest.event_type if latest else None,
            "last_event_amount": latest.amount if latest else None,
            "last_event_on": latest.occurred_on if latest else None,
            "installment_principal": installment.principal if installment else None,
            "installment_paid": installment.paid_amount if installment else None,
            "installment_periods": installment.periods if installment else None,
            "installment_status": installment.status if installment else None,
        })
    return payloads


register_order_list_payload_builder(_order_list_payload)
