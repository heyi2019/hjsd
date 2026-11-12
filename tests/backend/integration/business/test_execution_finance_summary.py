"""CALC-01 库存账号执行详情的财务汇总契约（ACC-01 execution-detail）。

前端 `stocks/OrderDetail.tsx` 与 `stocks/inventory-export.ts` 原先各自对
`orders[].events[].cashflow` + `orders[].cashflows` + `orders[].rebates` 做一遍
浮点累加，同一套算法写了两遍。汇总改由后端下发后，这里守住三条：

1. 合计等于明细逐条相加（口径同源，不另算一套）；
2. 收入含返点、支出只算流水，净额 = 收入 − 支出；
3. 没有任何流水/返点时给 0.00，不是 null 也不缺字段。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.domain.foundation import Pool
from app.domain.trade import RebateRecord
from app.finance import service as finance_service
from app.orders import service as orders_service
from app.stocks import service

TODAY = date(2026, 10, 4)


def _account(seeded_db, game_account: str):
    return service.create_account(
        seeded_db,
        game_account=game_account,
        platform="王者",
        actor="pytest",
        business_mode="SELF",
        inventory_type="RECOVERY",
    )


def _invest_pool(seeded_db) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
    assert pool is not None
    return pool


def _buy(seeded_db, account, *, amount: str, pool_id: int | None = None):
    order = orders_service.create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    orders_service.post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal(amount),
        occurred_on=TODAY,
        actor="pytest",
        pool_id=pool_id,
    )
    return order


def _detail_row(seeded_client, headers, account_id: int) -> dict:
    response = seeded_client.get(
        f"/api/v1/stocks/{account_id}/execution-detail", headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def _summary(seeded_client, headers, account_id: int) -> dict:
    return _detail_row(seeded_client, headers, account_id)["finance_summary"]


def _rebate(seeded_db, order_id: int, *, base_amount: str) -> RebateRecord:
    record = RebateRecord(
        rebate_no=f"RB-SUMMARY-{order_id}",
        source_order_id=order_id,
        rebate_type="BUY",
        rate=Decimal("10"),
        base_amount=Decimal(base_amount),
        status="SETTLED",
        collected_on=TODAY,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(record)
    seeded_db.commit()
    return record


def test_summary_counts_event_flow_as_expense(seeded_client, seeded_db, headers):
    account = _account(seeded_db, "summary-buy-only")
    pool = _invest_pool(seeded_db)
    _buy(seeded_db, account, amount="300", pool_id=pool.id)

    summary = _summary(seeded_client, headers, account.id)

    assert Decimal(summary["total_expense"]) == Decimal("300.00")
    assert Decimal(summary["cashflow_income"]) == Decimal("0.00")
    assert Decimal(summary["rebate_income"]) == Decimal("0.00")
    assert Decimal(summary["total_income"]) == Decimal("0.00")
    assert Decimal(summary["net_amount"]) == Decimal("-300.00")


def test_summary_splits_cashflow_and_rebate_income(seeded_client, seeded_db, headers):
    account = _account(seeded_db, "summary-mixed")
    pool = _invest_pool(seeded_db)
    order = _buy(seeded_db, account, amount="300", pool_id=pool.id)
    # 订单关联的独立流水（没有 order_event_id），走 orders[].cashflows 分支。
    finance_service.create_cashflow(
        seeded_db,
        pool_id=pool.id,
        occurred_on=TODAY,
        direction="IN",
        nature="BUSINESS_IN",
        category="OTHER",
        amount=Decimal("100"),
        order_id=order.id,
        actor="pytest",
        note="订单关联收入",
    )
    _rebate(seeded_db, order.id, base_amount="50")

    summary = _summary(seeded_client, headers, account.id)

    assert Decimal(summary["cashflow_income"]) == Decimal("100.00")
    assert Decimal(summary["rebate_income"]) == Decimal("50.00")
    assert Decimal(summary["total_income"]) == Decimal("150.00")
    assert Decimal(summary["total_expense"]) == Decimal("300.00")
    # 净额 = 所有收入 − 所有支出；返点登记即收入，必须并入净额（11-05 裁决）。
    assert Decimal(summary["net_amount"]) == Decimal("-150.00")


def test_summary_equals_manual_sum_over_detail_rows(seeded_client, seeded_db, headers):
    """汇总必须等于把 orders 明细逐条相加的结果，避免后端另算一套口径。"""
    account = _account(seeded_db, "summary-reconcile")
    pool = _invest_pool(seeded_db)
    order = _buy(seeded_db, account, amount="300", pool_id=pool.id)
    finance_service.create_cashflow(
        seeded_db,
        pool_id=pool.id,
        occurred_on=TODAY,
        direction="OUT",
        nature="BUSINESS_OUT",
        category="OTHER",
        amount=Decimal("12.34"),
        order_id=order.id,
        actor="pytest",
    )
    finance_service.create_cashflow(
        seeded_db,
        pool_id=pool.id,
        occurred_on=TODAY,
        direction="IN",
        nature="BUSINESS_IN",
        category="OTHER",
        amount=Decimal("88.66"),
        order_id=order.id,
        actor="pytest",
    )
    _rebate(seeded_db, order.id, base_amount="20")

    payload = _detail_row(seeded_client, headers, account.id)
    summary = payload["finance_summary"]

    inflow = Decimal("0.00")
    outflow = Decimal("0.00")
    rebate_total = Decimal("0.00")
    for order_row in payload["orders"]:
        for event in order_row["events"]:
            flow = event.get("cashflow")
            if not flow:
                continue
            if flow["direction"] == "IN":
                inflow += Decimal(flow["amount"])
            else:
                outflow += Decimal(flow["amount"])
        for flow in order_row["cashflows"]:
            if flow["direction"] == "IN":
                inflow += Decimal(flow["amount"])
            else:
                outflow += Decimal(flow["amount"])
        for rebate in order_row["rebates"]:
            rebate_total += Decimal(rebate["base_amount"])

    assert Decimal(summary["cashflow_income"]) == inflow == Decimal("88.66")
    assert Decimal(summary["total_expense"]) == outflow == Decimal("312.34")
    assert Decimal(summary["rebate_income"]) == rebate_total == Decimal("20.00")
    assert Decimal(summary["total_income"]) == inflow + rebate_total
    # 净额允许为负，用 Decimal 精确比较，不经 float。
    # 资金走向只有收入 / 支出：返点虽不生成流水，仍是收入，计入净额。
    assert Decimal(summary["net_amount"]) == inflow + rebate_total - outflow == Decimal("-203.68")


def test_summary_is_zero_without_any_flow(seeded_client, seeded_db, headers):
    account = _account(seeded_db, "summary-empty")

    summary = _summary(seeded_client, headers, account.id)

    for key in ("cashflow_income", "rebate_income", "total_income", "total_expense", "net_amount"):
        assert Decimal(summary[key]) == Decimal("0.00"), key

def test_deposit_loss_visible_in_detail_but_excluded_from_summary(seeded_client, seeded_db, headers):
    """押金损失：明细列表仍可见（台账），但 finance_summary 与订单利润同源。

    2026-11-12 裁决 C 的库存详情收口：缴 1000 → 损 300 → 退 700。
    - 明细 orders[].cashflows 仍展示损失那笔 OUT（台账真实可见）；
    - 汇总 net_amount 排除损失第二次流出，= 订单利润 = −600（不是 −900）。
    """
    from app.orders.amounts import order_cashflow_profit_by_order

    account = _account(seeded_db, "summary-deposit-loss")
    pool = _invest_pool(seeded_db)
    order = _buy(seeded_db, account, amount="300", pool_id=pool.id)

    dep = finance_service.create_deposit(
        seeded_db, pool_id=pool.id, amount=Decimal("1000"), paid_on=TODAY,
        source_order_id=order.id, actor="pytest",
    )
    finance_service.lose_deposit(
        seeded_db, dep.id, amount=Decimal("300"), lost_on=TODAY,
        category="OPERATING_COST", reason="违约", actor="pytest",
    )
    finance_service.return_deposit(
        seeded_db, dep.id, amount=Decimal("700"), released_on=TODAY, actor="pytest",
    )
    seeded_db.flush()

    payload = _detail_row(seeded_client, headers, account.id)
    summary = payload["finance_summary"]
    profit = order_cashflow_profit_by_order(seeded_db, order_ids=[order.id])[order.id]

    # 明细仍展示押金损失流水（category=OPERATING_COST，OUT 300）作台账
    loss_rows = [
        flow
        for o in payload["orders"]
        for flow in o["cashflows"]
        if flow["direction"] == "OUT" and flow["category"] == "OPERATING_COST"
    ]
    assert len(loss_rows) == 1, f"押金损失流水应在明细可见（台账），实际 {loss_rows}"

    # 汇总排除损失第二次流出：支出侧只算占用 1000 + BUY 300，不含损失 300
    assert Decimal(summary["cashflow_income"]) == Decimal("700.00")
    assert Decimal(summary["total_expense"]) == Decimal("1300.00")
    # 净额与订单利润逐笔同源（−600，而非把损失重复计入的 −900）
    assert Decimal(summary["net_amount"]) == profit == Decimal("-600.00")
