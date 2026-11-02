"""库存执行事件的「仍可冲销余额」契约（ACC-01 execution-detail）。

前端 `findCancelableEvent` 原先自己遍历同订单的 CANCEL 事件做
`amount − Σcancel`，与后端 `post_event` 的冲销校验是两套实现：金额口径、
「是否只算 is_posted」、多笔分次冲销的累加都可能漂移。改由后端在
`ExecutionEventOut.cancellable_amount` 下发后，这里守住：

1. 首发布事件的可冲销余额 = 事件金额；
2. 分次冲销累加扣减，且夹底 0；
3. 全额冲销后为 0.00（事件仍在明细里，前端据此跳过）；
4. CANCEL 事件自身恒为 0.00（不能被二次冲销）。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.domain.foundation import Pool
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


def _buy(seeded_db, account, *, amount: str):
    pool = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
    assert pool is not None
    order = orders_service.create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    event, _flow = orders_service.post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal(amount),
        occurred_on=TODAY,
        actor="pytest",
        pool_id=pool.id,
    )
    return order, event


def _cancel(seeded_db, order, *, offset_event_id: int, amount: str):
    event, _flow = orders_service.post_event(
        seeded_db,
        order.id,
        event_type="CANCEL",
        amount=Decimal(amount),
        occurred_on=TODAY,
        actor="pytest",
        offset_event_id=offset_event_id,
        reason="测试冲销",
    )
    return event


def _events(seeded_client, headers, account_id: int) -> list[dict]:
    response = seeded_client.get(
        f"/api/v1/stocks/{account_id}/execution-detail", headers=headers
    )
    assert response.status_code == 200, response.text
    return [event for order in response.json()["orders"] for event in order["events"]]


def _by_id(rows: list[dict], event_id: int) -> dict:
    for row in rows:
        if row["id"] == event_id:
            return row
    raise AssertionError(f"事件 {event_id} 不在明细里")


def test_fresh_event_is_fully_cancellable(seeded_client, seeded_db, headers):
    account = _account(seeded_db, "cancel-fresh")
    _order, buy = _buy(seeded_db, account, amount="300")

    row = _by_id(_events(seeded_client, headers, account.id), buy.id)

    assert Decimal(row["amount"]) == Decimal("300.00")
    assert Decimal(row["cancellable_amount"]) == Decimal("300.00")


def test_cancellable_amount_accumulates_across_partial_cancels(
    seeded_client, seeded_db, headers
):
    account = _account(seeded_db, "cancel-partial")
    order, buy = _buy(seeded_db, account, amount="300")
    _cancel(seeded_db, order, offset_event_id=buy.id, amount="120")
    _cancel(seeded_db, order, offset_event_id=buy.id, amount="80")

    rows = _events(seeded_client, headers, account.id)
    row = _by_id(rows, buy.id)

    # 300 − 120 − 80 = 100：分次冲销必须累加，不能只看最后一笔。
    assert Decimal(row["cancellable_amount"]) == Decimal("100.00")
    assert Decimal(row["amount"]) == Decimal("300.00"), "原始金额不被冲销改写"


def test_fully_cancelled_event_reports_zero_and_stays_in_detail(
    seeded_client, seeded_db, headers
):
    account = _account(seeded_db, "cancel-full")
    order, buy = _buy(seeded_db, account, amount="300")
    _cancel(seeded_db, order, offset_event_id=buy.id, amount="300")

    row = _by_id(_events(seeded_client, headers, account.id), buy.id)

    assert Decimal(row["cancellable_amount"]) == Decimal("0.00")


def test_cancel_event_itself_is_not_cancellable(seeded_client, seeded_db, headers):
    account = _account(seeded_db, "cancel-self")
    order, buy = _buy(seeded_db, account, amount="300")
    cancel = _cancel(seeded_db, order, offset_event_id=buy.id, amount="100")

    row = _by_id(_events(seeded_client, headers, account.id), cancel.id)

    assert row["event_type"] == "CANCEL"
    assert Decimal(row["cancellable_amount"]) == Decimal("0.00")


def test_every_event_row_carries_the_field(seeded_client, seeded_db, headers):
    """字段恒下发（缺省 0.00）：前端用 Number(...) 判断，null/缺字段会变成 NaN 而静默失效。"""
    account = _account(seeded_db, "cancel-field-always")
    order, buy = _buy(seeded_db, account, amount="100")
    _cancel(seeded_db, order, offset_event_id=buy.id, amount="40")

    rows = _events(seeded_client, headers, account.id)

    assert rows, "明细里应至少有一条事件"
    for row in rows:
        assert "cancellable_amount" in row, row
        assert isinstance(row["cancellable_amount"], str), row
        assert Decimal(row["cancellable_amount"]) >= Decimal("0.00"), row
