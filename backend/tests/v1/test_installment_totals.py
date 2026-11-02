"""分期台合计（总应收 / 已收 / 剩余）走服务端（INST）。

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

from app.orders import service as orders_service
from app.value_added_services import service as installment_service

D1 = date(2026, 9, 1)
D2 = date(2026, 10, 15)


def _contract(seeded_db, *, trade_date: date, paid: str = "0", down: str = "200.00",
              periods: int = 2, per_period: str = "500.00"):
    order = orders_service.create_order(
        seeded_db, order_type="DG", trade_date=trade_date, actor="pytest"
    )
    contract = installment_service.create_installment(
        seeded_db,
        order_id=order.id,
        contract_type="CONSIGNMENT_SALE",
        principal=Decimal("1200.00"),
        down_payment=Decimal(down),
        periods=periods,
        per_period=Decimal(per_period),
        first_due_on=trade_date,
        actor="pytest",
    )
    if paid != "0":
        contract.paid_amount = Decimal(paid)
    seeded_db.commit()
    return contract


def _totals(seeded_client, headers, **params):
    response = seeded_client.get("/api/v1/installments/totals", params=params, headers=headers)
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

    listed = seeded_client.get("/api/v1/installments", headers=headers)
    assert listed.status_code == 200, listed.text
    rows = listed.json()
    assert rows

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
        "/api/v1/installments",
        params={"trade_date_from": D2.isoformat(), "trade_date_to": D2.isoformat()},
        headers=headers,
    )
    assert listed.status_code == 200, listed.text
    assert [row["id"] for row in listed.json()] == [late.id]

    receivable, paid, remaining = _totals(
        seeded_client,
        headers,
        trade_date_from=D2.isoformat(),
        trade_date_to=D2.isoformat(),
    )
    assert receivable == Decimal(listed.json()[0]["total_receivable"])
    assert paid == Decimal(listed.json()[0]["paid_amount"])
    assert remaining == Decimal(listed.json()[0]["remaining_receivable"])


def test_totals_remaining_never_negative(seeded_client, seeded_db, headers):
    contract = _contract(seeded_db, trade_date=D1, paid="900.00")
    contract.waived_amount = Decimal("500.00")
    seeded_db.commit()

    listed = seeded_client.get("/api/v1/installments", headers=headers).json()
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
