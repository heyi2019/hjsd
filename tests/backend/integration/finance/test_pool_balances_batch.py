"""POOL-01 资金账户批量余额与汇总（FIN-01）。

背景：资金页 / 数据中心原先按池逐个调 `/pools/{id}/balance`（N+1），再用浮点把
卡片相加算「总余额 / 可用 / 押金」。合计属财务事实，改由服务端一次算清，
本文件锁住：

1. 批量接口每池的余额与单池端点完全一致（口径不能分叉）；
2. `totals` 与 items 的 Decimal 累加一致（不是前端那套浮点）；
3. 无池授权的账号拿到空 items 与零合计，而不是 403 或越权数据。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import event

from app.domain.trade import Cashflow
from app.finance.balances import pool_balances
from app.finance.cashflow.cashflows import create_cashflow

TODAY = date(2026, 10, 4)


def test_balance_aggregates_attributes_before_returning_rows(seeded_db):
    """同方向同来源的不同属性应合并，减少聚合结果且保持金额。"""
    for number, attribute, amount in [(1, "SELF_REVENUE", "10.10"), (2, "OTHER_INCOME", "20.20")]:
        seeded_db.add(Cashflow(
            flow_no=f"TEST-AGG-{number}", pool_id=1, occurred_on=TODAY,
            direction="IN", source_type="MANUAL", accounting_attribute=attribute,
            category="OTHER", amount=Decimal(amount), created_by="pytest", updated_by="pytest",
        ))
    seeded_db.flush()
    row_counts = []

    def record_rows(_conn, cursor, statement, _params, _context, _many):
        sql = statement.lower()
        if "from cashflow" in sql and "group by" in sql:
            row_counts.append(cursor.rowcount)

    connection = seeded_db.connection()
    event.listen(connection, "after_cursor_execute", record_rows)
    try:
        balance = pool_balances(seeded_db, [1])[1]
    finally:
        event.remove(connection, "after_cursor_execute", record_rows)
    assert balance["income"] == Decimal("30.30")
    assert balance["cash_balance"] == Decimal("30.30")
    assert row_counts == [1]


def _flow(seeded_db, pool_id: int, *, direction: str, amount: str, note: str):
    return create_cashflow(
        seeded_db,
        pool_id=pool_id,
        occurred_on=TODAY,
        direction=direction,
        category="OPERATING",
        amount=Decimal(amount),
        note=note,
        actor="pytest",
    )


def test_batch_items_match_single_pool_and_totals_are_decimal_sums(
    seeded_client, seeded_db, headers
):
    _flow(seeded_db, 1, direction="IN", amount="1200.10", note="批量入")
    _flow(seeded_db, 1, direction="OUT", amount="200.05", note="批量出")
    seeded_db.commit()

    batch = seeded_client.get("/api/pools/balances", headers=headers)
    assert batch.status_code == 200, batch.text
    body = batch.json()

    assert body["items"], "至少应返回种子里已有的资金账户"
    for item in body["items"]:
        single = seeded_client.get(
            f"/api/pools/{item['pool_id']}/balance", headers=headers
        )
        assert single.status_code == 200, single.text
        assert item["cash_balance"] == single.json()["cash_balance"]
        assert item["available"] == single.json()["available"]
        assert item["deposit_held"] == single.json()["deposit_held"]

    totals = body["totals"]
    assert Decimal(totals["cash_balance"]) == sum(
        (Decimal(item["cash_balance"]) for item in body["items"]), Decimal("0")
    )
    assert Decimal(totals["available"]) == sum(
        (Decimal(item["available"]) for item in body["items"]), Decimal("0")
    )
    assert Decimal(totals["deposit_held"]) == sum(
        (Decimal(item["deposit_held"]) for item in body["items"]), Decimal("0")
    )


def test_account_without_pool_scope_gets_empty_batch(seeded_client, viewer_headers):
    response = seeded_client.get("/api/pools/balances", headers=viewer_headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["items"] == []
    assert Decimal(body["totals"]["cash_balance"]) == Decimal("0")
