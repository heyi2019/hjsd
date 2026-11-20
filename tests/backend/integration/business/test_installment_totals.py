"""CALC-01 分期台合计（总应收 / 已收 / 剩余）走服务端（INST）。

背景：前端原先对当前页合约 `reduce` 求和、并自己相减算剩余。现由
`GET /installments/totals` 按与 `/installments` **同一套筛选条件**聚合，本文件锁住：

1. 合计等于列表逐条之和（口径不能两套）；
2. 成交日期区间筛选在列表与合计上同时生效（前端不再本地筛）；
3. 剩余按 0 夹底，合计不会因为减免出现负数；
4. 状态筛选同样两边一致。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.business.create import create_order
from app.business.events import post_event
from app.funds.installments import create as inst_create

D1 = date(2026, 9, 1)
D2 = date(2026, 10, 15)


def _contract(seeded_db, *, trade_date: date, paid: str = "0", down: str = "200.00",
              periods: int = 2, per_period: str = "500.00", contract_type: str = "PICKUP_SALE"):
    # PICKUP_SALE 仅 TH 且天然不带账号（保持其余合计用例的最简构造）。
    # STOCK_SALE 要求账号已入库：先建账号 + BUY 事件，再走 HS 订单。
    if contract_type == "STOCK_SALE":
        from app.business.stocks.profile import create_account

        account = create_account(
            seeded_db,
            game_account=f"totals-stock-{trade_date.isoformat()}",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        )
        order = create_order(
            seeded_db, order_type="HS", trade_date=trade_date, actor="pytest",
            account_id=account.id,
        )
        post_event(
            seeded_db, order.id, event_type="BUY", amount="1200.00",
            occurred_on=trade_date, actor="pytest", pool_id=1,
        )
    else:
        order = create_order(
            seeded_db, order_type="TH", trade_date=trade_date, actor="pytest"
        )
    contract = inst_create.create_installment(
        seeded_db,
        order_id=order.id,
        contract_type=contract_type,
        principal=Decimal("1200.00"),
        down_payment=Decimal(down),
        periods=periods,
        per_period=Decimal(per_period),
        first_due_on=trade_date,
        actor="pytest",
    )
    if paid != "0" and contract_type != "STOCK_SALE":
        contract.paid_amount = Decimal(paid)
    seeded_db.commit()
    return contract


def _totals(seeded_client, headers, **params):
    response = seeded_client.get("/api/installments/totals", params=params, headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    return (
        Decimal(body["total_receivable"]),
        Decimal(body["total_paid"]),
        Decimal(body["total_remaining"]),
    )


def test_totals_match_list_rows(seeded_client, seeded_db, headers):
    _contract(seeded_db, trade_date=D1)
    _contract(seeded_db, trade_date=D2, paid="300.00")

    listed = seeded_client.get("/api/installments", headers=headers)
    assert listed.status_code == 200, listed.text
    rows = listed.json()["items"]
    assert rows

    summary = seeded_client.get("/api/installments/totals", headers=headers).json()
    assert summary["total_count"] == len(rows)
    assert summary["overdue_count"] == sum(row["status"] == "OVERDUE" for row in rows)

    expected_receivable = sum(Decimal(row["total_receivable"]) for row in rows)
    expected_paid = sum(Decimal(row["paid_amount"]) for row in rows)
    expected_remaining = sum(Decimal(row["remaining_receivable"]) for row in rows)

    assert _totals(seeded_client, headers) == (
        expected_receivable,
        expected_paid,
        expected_remaining,
    )


def test_trade_date_range_filters_both_list_and_totals(seeded_client, seeded_db, headers):
    _contract(seeded_db, trade_date=D1)
    late = _contract(seeded_db, trade_date=D2)

    listed = seeded_client.get(
        "/api/installments",
        params={"trade_date_from": D2.isoformat(), "trade_date_to": D2.isoformat()},
        headers=headers,
    )
    assert listed.status_code == 200, listed.text
    assert [row["id"] for row in listed.json()["items"]] == [late.id]

    receivable, paid, remaining = _totals(
        seeded_client,
        headers,
        trade_date_from=D2.isoformat(),
        trade_date_to=D2.isoformat(),
    )
    assert receivable == Decimal(listed.json()["items"][0]["total_receivable"])
    assert paid == Decimal(listed.json()["items"][0]["paid_amount"])
    assert remaining == Decimal(listed.json()["items"][0]["remaining_receivable"])


def test_totals_remaining_never_negative(seeded_client, seeded_db, headers):
    contract = _contract(seeded_db, trade_date=D1, paid="900.00")
    contract.waived_amount = Decimal("500.00")
    seeded_db.commit()

    listed = seeded_client.get("/api/installments", headers=headers).json()["items"]
    row = next(item for item in listed if item["id"] == contract.id)
    assert Decimal(row["remaining_receivable"]) == Decimal("0.00")

    _, _, remaining = _totals(seeded_client, headers)
    assert remaining >= Decimal("0")


def test_totals_follow_status_filter(seeded_client, seeded_db, headers):
    _contract(seeded_db, trade_date=D1, paid="100.00")

    # 新建合约初始状态是 PENDING：按 PENDING 计数、按 SETTLED 归零，两边同口径。
    pending = _totals(seeded_client, headers, status="PENDING")
    settled = _totals(seeded_client, headers, status="SETTLED")

    assert pending[0] >= Decimal("1200.00")
    assert settled == (Decimal("0"), Decimal("0"), Decimal("0"))


def test_contract_type_filters_both_list_and_totals(seeded_client, seeded_db, headers):
    """分期面板按 contract_type 分列：列表与合计必须同受该条件约束，不能混入其它类型合同。"""
    # 两类金额刻意不同：STOCK_SALE 每期 600（合计 1400），PICKUP_SALE 每期 500（合计 1200）。
    stock = _contract(seeded_db, trade_date=D1, contract_type="STOCK_SALE", per_period="600.00")
    pickup = _contract(seeded_db, trade_date=D1, contract_type="PICKUP_SALE")

    listed = seeded_client.get(
        "/api/installments", params={"contract_type": "STOCK_SALE"}, headers=headers
    )
    assert listed.status_code == 200, listed.text
    rows = listed.json()["items"]
    assert [row["id"] for row in rows] == [stock.id]
    assert pickup.id not in [row["id"] for row in rows]

    expected_receivable = sum(Decimal(row["total_receivable"]) for row in rows)
    expected_paid = sum(Decimal(row["paid_amount"]) for row in rows)
    expected_remaining = sum(Decimal(row["remaining_receivable"]) for row in rows)
    assert _totals(seeded_client, headers, contract_type="STOCK_SALE") == (
        expected_receivable,
        expected_paid,
        expected_remaining,
    )

    # 按 PICKUP_SALE 过滤时只回另一份合约，合计随之切换，证明不是同一口袋。
    pickup_rows = seeded_client.get(
        "/api/installments", params={"contract_type": "PICKUP_SALE"}, headers=headers
    ).json()["items"]
    assert [row["id"] for row in pickup_rows] == [pickup.id]
    pickup_totals = _totals(seeded_client, headers, contract_type="PICKUP_SALE")
    assert pickup_totals == (
        Decimal(pickup_rows[0]["total_receivable"]),
        Decimal(pickup_rows[0]["paid_amount"]),
        Decimal(pickup_rows[0]["remaining_receivable"]),
    )
    assert pickup_totals != (expected_receivable, expected_paid, expected_remaining)
