"""订单事件与现金流的唯一写入入口。

事件说明真实业务动作；资金流水说明该动作造成的现金变化。所有有资金影响的
订单事件均由本模块在同一事务内生成恰好一条 CashFlow，禁止两边分别手工录入。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from app.models_new.entities import CashFlow, Order, OrderEvent
from app.services_new.numbering import gen_event_no, gen_flow_no, gen_transfer_id


MONEY_EVENTS = {"BUY", "SELL", "REBATE", "CANCEL"}
INFLOW_EVENTS = {"SELL", "REBATE", "CANCEL"}


def record_order_event(
    db: Session,
    *,
    order: Order,
    event_type: str,
    amount: Decimal,
    occurred_on: date,
    pool_id: int,
    portion: str = "GROSS",
    counterparty: str = "",
    note: str = "",
    offset_event_id: int | None = None,
) -> OrderEvent:
    """记录一项业务资金动作，并原子地生成对应现金流。

    TRANSFER 只能通过 :func:`transfer_between_pools` 创建，因为它必须成对。
    amount 必须为正数；收入/支出的方向由事件类型确定，避免符号被反写。
    """
    if event_type not in MONEY_EVENTS:
        raise ValueError(f"不支持的业务资金事件：{event_type}")
    if amount <= 0:
        raise ValueError("事件金额必须大于 0")
    if not pool_id:
        raise ValueError("业务资金事件必须指定 pool_id")

    # 同一订单可能有本金、利润两条 SELL，编号需保留可读的动作前缀并保持唯一。
    suffix = "" if portion == "GROSS" else f"-{portion}"
    event = OrderEvent(
        event_no=gen_event_no(order.order_no, event_type) + suffix,
        order_id=order.id,
        event_type=event_type,
        amount=amount,
        occurred_on=occurred_on,
        pool_id=pool_id,
        portion=portion,
        counterparty=counterparty,
        note=note,
        offset_event_id=offset_event_id,
    )
    db.add(event)
    db.flush()

    direction = "收入" if event_type in INFLOW_EVENTS else "支出"
    nature = "BUSINESS_IN" if event_type in INFLOW_EVENTS else "BUSINESS_OUT"
    db.add(CashFlow(
        flow_no=gen_flow_no(db),
        pool_id=pool_id,
        occurred_on=occurred_on,
        nature=nature,
        category="账号回收" if event_type != "REBATE" else "返点",
        direction=direction,
        amount=amount,
        order_id=order.id,
        order_event_id=event.id,
        source="event",
        remark=note or f"{event.event_no} 自动生成",
    ))
    db.flush()
    return event


def transfer_between_pools(
    db: Session,
    *,
    source_pool_id: int,
    target_pool_id: int,
    amount: Decimal,
    occurred_on: date,
    remark: str = "",
) -> str:
    """创建一组跨池划转。

    划转改变源池和目标池的余额，但不改变合并现金头寸或经营损益。
    """
    if source_pool_id == target_pool_id:
        raise ValueError("跨池划转的源池与目标池不能相同")
    if amount <= 0:
        raise ValueError("划转金额必须大于 0")

    transfer_id = gen_transfer_id(db)
    for pool_id, direction in ((source_pool_id, "支出"), (target_pool_id, "收入")):
        db.add(CashFlow(
            flow_no=gen_flow_no(db), pool_id=pool_id, occurred_on=occurred_on,
            nature="INTERNAL", category="池间划转", direction=direction,
            amount=amount, transfer_id=transfer_id, source="transfer", remark=remark,
        ))
    db.flush()
    return transfer_id
