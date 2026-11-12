"""CALC-01 订单事件的「仍可冲销余额」契约（ORD-01 订单详情 / 事件提交）。

订单页 `useOrdersPageController.reversibleEvents` 原先自己遍历同订单的 CANCEL 事件
做 `amount − Σcancel`，与库存页、以及 `post_event` 的冲销校验是三套实现：
「是否只算 is_posted」、分次冲销是否累加、夹底与否都可能各自漂移。
改由后端在 `EventOut.cancellable_amount` 下发后，这里守住：

1. 首发布事件的可冲销余额 = 事件金额；
2. 分次冲销累加扣减，夹底 0；
3. CANCEL 事件自身恒为 0.00（不能被二次冲销）；
4. 提交事件的响应也带同一口径的值（前端拿到就能直接回填默认冲销金额）。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.domain.foundation import Pool
from app.orders.create import create_order
from app.orders.events import post_event

TODAY = date(2026, 10, 4)


def _order_with_buy(seeded_db, *, amount: str):
    pool = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
    assert pool is not None
    order = create_order(
        seeded_db,
        order_type="HS",
        trade_date=TODAY,
        actor="pytest",
        # HS 买入必须能定位到游戏账号：快照带 game_account 才会自动建库存账号。
        account_snapshot={"game_account": f"evt-{amount}", "platform": "王者"},
    )
    buy, _flow = post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal(amount),
        occurred_on=TODAY,
        actor="pytest",
        pool_id=pool.id,
    )
    return order, buy


def _cancel(seeded_db, order, *, offset_event_id: int, amount: str):
    event, _flow = post_event(
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


def _detail_events(seeded_client, headers, order_id: int) -> list[dict]:
    response = seeded_client.get(f"/api/v1/orders/{order_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["events"]


def _by_id(rows: list[dict], event_id: int) -> dict:
    for row in rows:
        if row["id"] == event_id:
            return row
    raise AssertionError(f"事件 {event_id} 不在订单详情里")


def test_fresh_order_event_is_fully_cancellable(seeded_client, seeded_db, headers):
    order, buy = _order_with_buy(seeded_db, amount="500")

    row = _by_id(_detail_events(seeded_client, headers, order.id), buy.id)

    assert Decimal(row["amount"]) == Decimal("500.00")
    assert Decimal(row["cancellable_amount"]) == Decimal("500.00")


def test_cancellable_amount_accumulates_across_partial_cancels(
    seeded_client, seeded_db, headers
):
    order, buy = _order_with_buy(seeded_db, amount="500")
    _cancel(seeded_db, order, offset_event_id=buy.id, amount="200")
    _cancel(seeded_db, order, offset_event_id=buy.id, amount="150")

    row = _by_id(_detail_events(seeded_client, headers, order.id), buy.id)

    # 500 − 200 − 150 = 150：分次冲销必须累加，不能只看最后一笔。
    assert Decimal(row["cancellable_amount"]) == Decimal("150.00")
    assert Decimal(row["amount"]) == Decimal("500.00"), "原始金额不被冲销改写"


def test_fully_cancelled_event_reports_zero(seeded_client, seeded_db, headers):
    order, buy = _order_with_buy(seeded_db, amount="500")
    _cancel(seeded_db, order, offset_event_id=buy.id, amount="500")

    row = _by_id(_detail_events(seeded_client, headers, order.id), buy.id)

    assert Decimal(row["cancellable_amount"]) == Decimal("0.00")


def test_cancel_event_itself_is_not_cancellable(seeded_client, seeded_db, headers):
    order, buy = _order_with_buy(seeded_db, amount="500")
    cancel = _cancel(seeded_db, order, offset_event_id=buy.id, amount="120")

    row = _by_id(_detail_events(seeded_client, headers, order.id), cancel.id)

    assert row["event_type"] == "CANCEL"
    assert Decimal(row["cancellable_amount"]) == Decimal("0.00")


def test_every_event_row_carries_the_field(seeded_client, seeded_db, headers):
    """字段恒下发（缺省 0.00）：前端按数值判断，null/缺字段会变 NaN 而静默失效。"""
    order, buy = _order_with_buy(seeded_db, amount="100")
    _cancel(seeded_db, order, offset_event_id=buy.id, amount="40")

    rows = _detail_events(seeded_client, headers, order.id)

    assert rows, "详情里应至少有一条事件"
    for row in rows:
        assert "cancellable_amount" in row, row
        assert Decimal(row["cancellable_amount"]) >= Decimal("0.00"), row


def test_posted_event_response_carries_the_same_value(seeded_client, seeded_db, headers):
    """提交事件的响应体也带该字段：前端弹窗要用它回填「默认冲销金额」。"""
    order, buy = _order_with_buy(seeded_db, amount="300")

    response = seeded_client.post(
        f"/api/v1/orders/{order.id}/events",
        headers=headers,
        json={
            "event_type": "CANCEL",
            "amount": "300.00",
            "occurred_on": TODAY.isoformat(),
            "offset_event_id": buy.id,
            "reason": "接口冲销",
        },
    )

    assert response.status_code in (200, 201), response.text
    assert Decimal(response.json()["event"]["cancellable_amount"]) == Decimal("0.00"), (
        "CANCEL 自身不可再冲销"
    )
