"""FLOW-01 tests/backend/test_flow_sale：跨模块流程 B —— 账号售出（HS sell，BIZ-FLOW-SALE）。

业务链路（项目跨模块测试·流程 B）
-------------------------------
HS 回收单（带账号快照）→ 记 BUY 事件（采购成本）→ 记 SELL 事件（售出）
→ 账号状态 WAITING→SOLD、订单 COMPLETED、资金池余额净变动、报表利润、现金流同源。

本文件只验证**跨模块数据一致性**：同一业务动作在库存 / 订单 / 资金 / 报表四处
的状态同源、金额一致，不重复单模块已有的规则断言。
测试分类：API 集成（seeded_client）+ 服务级集成（seeded_db 校验 DB 状态）。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.domain.enums import Direction, EventType
from app.domain.foundation import Pool
from app.domain.trade import Account, Order
from app.domain.trade_models.cashflow import Cashflow
from app.reporting.profit import order_profit_detail

TODAY = date(2026, 10, 5)


def _first_active_pool(session) -> Pool:
    return session.scalars(select(Pool).where(Pool.status == "ACTIVE")).first()


def _post_hs_sell_order(seeded_client, headers, *, game_account: str):
    resp = seeded_client.post(
        "/api/v1/orders",
        json={
            "order_type": "HS",
            "trade_date": TODAY.isoformat(),
            "account_snapshot": {"game_account": game_account, "game_type": "王者荣耀"},
        },
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    return body["id"], body["account_id"]


def _pool_balance(client, headers, pool_id) -> Decimal:
    return Decimal(
        str(client.get(f"/api/v1/pools/{pool_id}/balance", headers=headers).json()["cash_balance"])
    )


def test_flow_b_hs_sell_end_to_end(seeded_client, headers, seeded_db):
    """BIZ-FLOW-SALE-001：HS 售出全链路，库存/订单/资金/报表四处同源一致。"""
    order_id, account_id = _post_hs_sell_order(
        seeded_client, headers, game_account="flow-b-001"
    )
    pool = _first_active_pool(seeded_db)
    baseline = _pool_balance(seeded_client, headers, pool.id)

    buy = seeded_client.post(
        f"/api/v1/orders/{order_id}/events",
        json={
            "event_type": EventType.BUY.value, "amount": "1000.00",
            "occurred_on": TODAY.isoformat(), "pool_id": pool.id,
        },
        headers=headers,
    )
    assert buy.status_code == 201, buy.text

    account = seeded_db.get(Account, account_id)
    # BUY_STOCK 不离开 WAITING；同时采购成本写入、池余额减少 1000。
    assert account.status == "WAITING"
    assert account.cost_amount == 1000
    assert _pool_balance(seeded_client, headers, pool.id) == baseline - Decimal("1000.00")

    sell = seeded_client.post(
        f"/api/v1/orders/{order_id}/events",
        json={
            "event_type": EventType.SELL.value, "amount": "1500.00",
            "occurred_on": TODAY.isoformat(), "pool_id": pool.id,
        },
        headers=headers,
    )
    assert sell.status_code == 201, sell.text

    account = seeded_db.get(Account, account_id)
    assert account.status == "SOLD"  # WAITING --SELL--> SOLD
    order = seeded_db.get(Order, order_id)
    assert order.status == "COMPLETED"  # ACTIVE --COMPLETE--> COMPLETED

    # 池余额 = 基线 + 收入(1500) − 支出(1000)
    assert _pool_balance(seeded_client, headers, pool.id) == (
        baseline + Decimal("1500.00") - Decimal("1000.00")
    )

    # 现金流同源：OUT(1000) + IN(1500)，登记即生效
    flows = seeded_db.scalars(
        select(Cashflow).where(Cashflow.order_id == order_id).order_by(Cashflow.id)
    ).all()
    assert [f.direction for f in flows] == [Direction.OUT.value, Direction.IN.value]
    assert all(not hasattr(f, "status") for f in flows)
    assert [f.amount for f in flows] == [1000, 1500]

    # 报表口径一致：收入 1500 / 成本 1000 / 净利 500
    detail = order_profit_detail(seeded_db, from_date=TODAY, to_date=TODAY)
    assert detail["total"]["income"] == Decimal("1500.00")
    assert detail["total"]["cost"] == Decimal("1000.00")
    assert detail["total"]["net_profit"] == Decimal("500.00")
