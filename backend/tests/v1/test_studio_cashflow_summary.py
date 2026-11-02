"""工作室收支面板汇总契约（FIN-04 /cashflows/studio-summary）。

前端 `pools/StudioExpensePanel.tsx` 原先发两次 `/cashflows`（收入一次、支出一次），
自己按 `source === "OTHER"` 过滤、再用 `reduce + toFixed` 算出已入账收入/支出/净额。
这套口径散在组件里有三个问题：`limit` 截断会少算、浮点累加、属性配对规则改一次就漂。

汇总搬后端后，这里守住：
1. 只算 APPROVED（待审核不进经营口径）；
2. 只算手工登记（返点/押金/划转/订单事件流水都不算工作室收支）；
3. 支出认 OPERATING_EXPENSE、收入认 SELF_REVENUE，不能互相串；
4. 汇总不受 items 的 limit 影响，净额由后端算。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.domain.foundation import Pool
from app.finance import service

TODAY = date(2026, 10, 4)


def _pool(seeded_db) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
    assert pool is not None
    return pool


def _flow(
    seeded_db,
    *,
    direction: str,
    attribute: str,
    amount: str,
    category: str = "房租",
    note: str = "memo",
):
    """手工登记一笔工作室收支：nature 与方向对齐，属性由调用方指定。"""
    return service.create_cashflow(
        seeded_db,
        pool_id=_pool(seeded_db).id,
        occurred_on=TODAY,
        direction=direction,
        nature="BUSINESS_OUT" if direction == "OUT" else "BUSINESS_IN",
        accounting_attribute=attribute,
        category=category,
        amount=Decimal(amount),
        actor="pytest",
        note=note,
    )


def _summary(seeded_client, headers, **params) -> dict:
    response = seeded_client.get(
        "/api/v1/cashflows/studio-summary", headers=headers, params=params
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_summary_counts_only_manual_flows(seeded_client, seeded_db, headers):
    expense = _flow(seeded_db, direction="OUT", attribute="OPERATING_EXPENSE", amount="300")
    income = _flow(seeded_db, direction="IN", attribute="SELF_REVENUE", amount="800")
    # 返点结算流水：category=REBATE，属于返点来源，不是手工登记的工作室收支。
    _flow(seeded_db, direction="IN", attribute="SELF_REVENUE", amount="50", category="REBATE")
    # 属性不配对：收入 + 运营消耗，不能进收入合计。
    _flow(seeded_db, direction="IN", attribute="OPERATING_EXPENSE", amount="70")

    payload = _summary(seeded_client, headers)

    numbers = {item["flow_no"] for item in payload["items"]}
    assert expense.flow_no in numbers
    assert income.flow_no in numbers
    assert payload["count"] == 2
    assert Decimal(payload["approved_expense"]) == Decimal("300.00")
    assert Decimal(payload["approved_income"]) == Decimal("800.00")
    assert Decimal(payload["approved_net"]) == Decimal("500.00")


def test_pending_flow_appears_in_items_but_not_in_summary(seeded_client, seeded_db, headers):
    flow = _flow(seeded_db, direction="OUT", attribute="OPERATING_EXPENSE", amount="120")
    flow.status = "PENDING"
    seeded_db.commit()

    payload = _summary(seeded_client, headers)

    assert [item["flow_no"] for item in payload["items"]] == [flow.flow_no]
    assert Decimal(payload["approved_expense"]) == Decimal("0.00")
    assert Decimal(payload["approved_net"]) == Decimal("0.00")


def test_summary_ignores_item_limit(seeded_client, seeded_db, headers):
    for index in range(3):
        _flow(
            seeded_db,
            direction="OUT",
            attribute="OPERATING_EXPENSE",
            amount="100",
            note=f"第{index}笔",
        )

    payload = _summary(seeded_client, headers, limit=1)

    assert len(payload["items"]) == 1
    # 汇总走 SQL SUM，不吃 limit：三条 100 仍是 300。
    assert Decimal(payload["approved_expense"]) == Decimal("300.00")


def test_summary_excludes_order_event_flows(seeded_client, seeded_db, headers):
    from app.orders import service as orders_service
    from app.stocks import service as stocks_service

    account = stocks_service.create_account(
        seeded_db,
        game_account="studio-summary-acc",
        platform="王者",
        actor="pytest",
        business_mode="SELF",
        inventory_type="RECOVERY",
    )
    order = orders_service.create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    # 订单事件派生的 BUY 流水挂在 order_event_id 上，source 是 ORDER_EVENT。
    orders_service.post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal("500"),
        occurred_on=TODAY,
        actor="pytest",
        pool_id=_pool(seeded_db).id,
    )

    payload = _summary(seeded_client, headers)

    assert payload["items"] == []
    assert Decimal(payload["approved_expense"]) == Decimal("0.00")


def test_pool_ids_filter(seeded_client, seeded_db, headers):
    other = Pool(
        code="STUDIO-OTHER",
        name="另一工作室",
        pool_type="OPERATING",
        ownership="OWNED",
        status="ACTIVE",
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(other)
    seeded_db.commit()

    mine = _flow(seeded_db, direction="OUT", attribute="OPERATING_EXPENSE", amount="100")
    service.create_cashflow(
        seeded_db,
        pool_id=other.id,
        occurred_on=TODAY,
        direction="OUT",
        nature="BUSINESS_OUT",
        accounting_attribute="OPERATING_EXPENSE",
        category="房租",
        amount=Decimal("900"),
        actor="pytest",
        note="别的池",
    )

    payload = _summary(seeded_client, headers, pool_ids=str(mine.pool_id))

    assert payload["count"] == 1
    assert Decimal(payload["approved_expense"]) == Decimal("100.00")


def test_pool_ids_must_be_integers(seeded_client, headers):
    response = seeded_client.get(
        "/api/v1/cashflows/studio-summary",
        headers=headers,
        params={"pool_ids": "1,abc"},
    )

    assert response.status_code == 422, response.text
