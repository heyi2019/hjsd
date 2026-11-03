"""FLOW-01 tests/backend/test_flow_recycle：跨模块流程 A —— 自营回收（BIZ-FLOW-RECYCLE）。

业务链路（项目第七阶段·跨模块测试·流程 A）
------------------------------------------
客户(可省略) → 回收订单(HS + 账号快照) → 内联入库(Account) → 记 BUY 事件(采购成本)
→ 资金流水(Cashflow, 支出) → 资金池余额变化 → 账号成本(cost_amount) 写入
→ 订单详情可见该流水。

本文件只验证**跨模块数据一致性**：同一个业务动作在库存/订单/资金三处的状态同源、
金额一致，不重复单模块已有的规则断言（规则层见 test_stock_intake_contract /
test_finance_cashflows_service / test_foundation_pools_service）。

测试分类：API 集成（seeded_client + 真实 PG）+ 服务级集成（seeded_db 校验 DB 状态）。
不依赖生产库；conftest 已强制 TEST_DATABASE_URL 与 dev 库隔离、库名含 test。
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select

from app.domain.enums import CashflowStatus, Direction, EventType
from app.domain.foundation import Pool
from app.domain.trade_models.cashflow import Cashflow
from app.domain.trade import Account

TODAY = date(2026, 10, 4)


def _first_active_pool(session) -> Pool:
    return session.scalars(
        select(Pool).where(Pool.status == "ACTIVE")
    ).first()


def _post_hs_recycle(seeded_client, headers, *, game_account: str):
    """建一张 HS 回收单（携带账号快照），返回 (order_id, account_id)。"""
    resp = seeded_client.post(
        "/api/v1/orders",
        json={
            "order_type": "HS",
            "trade_date": TODAY.isoformat(),
            "account_snapshot": {
                "game_account": game_account,
                "game_type": "王者荣耀",
            },
        },
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    return body["id"], body["account_id"]


def test_recycle_flow_buy_event_records_cashflow_and_updates_pool_balance(
    seeded_client, headers, seeded_db
):
    """BIZ-FLOW-RECYCLE-001：回收建单→内联入库→记 BUY 事件，三处状态同源。

    黑盒：建 HS 单 + 记 BUY(1000, pool) → 201 且返回 cashflow_no；
    白盒：Cashflow 行落库（OUT/APPROVED/绑定本单/本池）、资金池余额减少 1000、
    账号 cost_amount 写入 1000、订单详情暴露该流水。
    """
    order_id, account_id = _post_hs_recycle(
        seeded_client, headers, game_account="flow-recycle-001"
    )
    pool = _first_active_pool(seeded_db)
    assert pool is not None
    # 基线现金余额（记账前，隔离种子数据）。
    balance_before = float(
        seeded_client.get(f"/api/v1/pools/{pool.id}/balance", headers=headers).json()[
            "cash_balance"
        ]
    )

    # 记 BUY 事件 = 采购成本支出，绑定资金账户。
    buy = seeded_client.post(
        f"/api/v1/orders/{order_id}/events",
        json={
            "event_type": EventType.BUY.value,
            "amount": "1000.00",
            "occurred_on": TODAY.isoformat(),
            "pool_id": pool.id,
        },
        headers=headers,
    )
    assert buy.status_code == 201, buy.text
    cashflow_no = buy.json()["cashflow_no"]
    assert cashflow_no is not None

    # 资金流水：方向 OUT、已审核、金额 1000、归属本单与本池。
    flow = seeded_db.scalars(
        select(Cashflow).where(Cashflow.order_id == order_id)
    ).one()
    assert flow.direction == Direction.OUT.value
    assert flow.status == CashflowStatus.APPROVED.value
    assert flow.amount == 1000
    assert flow.pool_id == pool.id

    # 资金池现金余额 = 已审核流水有符号和；支出 1000 应使 cash_balance 减少 1000。
    balance_after = float(
        seeded_client.get(f"/api/v1/pools/{pool.id}/balance", headers=headers).json()[
            "cash_balance"
        ]
    )
    assert balance_after == balance_before - 1000

    # 账号采购成本被写入（取消/重算不会丢）。
    account = seeded_db.get(Account, account_id)
    assert account is not None
    assert account.cost_amount == 1000

    # 订单详情暴露该流水（前端订单页/库存页同源展示）。
    detail = seeded_client.get(f"/api/v1/orders/{order_id}", headers=headers)
    assert detail.status_code == 200, detail.text
    cashflow_nos = [c["flow_no"] for c in detail.json().get("cashflows", [])]
    assert cashflow_no in cashflow_nos


def test_recycle_flow_pool_balance_is_signed_sum_of_cashflows(
    seeded_client, headers, seeded_db
):
    """BIZ-FLOW-RECYCLE-002：池现金余额严格随已审核支出流水变动（跨模块口径一致）。

    先取基线 cash_balance，记一笔 BUY(OUT 600) 后断言现金余额 = 基线 - 600；
    验证「余额 vs 流水集合」的聚合一致性，这正是报表/资金中心同源计算的根。
    """
    order_id, _ = _post_hs_recycle(
        seeded_client, headers, game_account="flow-recycle-002"
    )
    pool = _first_active_pool(seeded_db)
    baseline = float(
        seeded_client.get(f"/api/v1/pools/{pool.id}/balance", headers=headers).json()[
            "cash_balance"
        ]
    )

    buy = seeded_client.post(
        f"/api/v1/orders/{order_id}/events",
        json={
            "event_type": EventType.BUY.value,
            "amount": "600.00",
            "occurred_on": TODAY.isoformat(),
            "pool_id": pool.id,
        },
        headers=headers,
    )
    assert buy.status_code == 201, buy.text

    after_buy = float(
        seeded_client.get(f"/api/v1/pools/{pool.id}/balance", headers=headers).json()[
            "cash_balance"
        ]
    )
    assert after_buy == baseline - 600
