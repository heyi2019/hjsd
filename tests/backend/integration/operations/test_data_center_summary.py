"""数据中心汇总口径：售出、库存、工作室成本与利润。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.domain.foundation import Pool
from app.finance.cashflows import create_cashflow
from app.orders import events
from app.orders.create import create_order
from app.stocks.profile import create_account


TODAY = date(2026, 10, 6)


def _pool(seeded_db) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
    assert pool is not None
    return pool


def test_data_center_separates_costs_and_combines_profit(seeded_client, seeded_db, headers):
    sold_account = create_account(
        seeded_db,
        game_account="data-center-sold",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    sold_order = create_order(
        seeded_db,
        order_type="HS",
        trade_date=TODAY,
        actor="pytest",
        account_id=sold_account.id,
    )
    events.post_event(
        seeded_db,
        sold_order.id,
        event_type="BUY",
        amount=Decimal("100.00"),
        occurred_on=TODAY,
        actor="pytest",
    )
    events.post_event(
        seeded_db,
        sold_order.id,
        event_type="SELL",
        amount=Decimal("160.00"),
        occurred_on=TODAY,
        actor="pytest",
    )

    inventory_account = create_account(
        seeded_db,
        game_account="data-center-inventory",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    inventory_order = create_order(
        seeded_db,
        order_type="HS",
        trade_date=TODAY,
        actor="pytest",
        account_id=inventory_account.id,
    )
    events.post_event(
        seeded_db,
        inventory_order.id,
        event_type="BUY",
        amount=Decimal("70.00"),
        occurred_on=TODAY,
        actor="pytest",
    )

    pool_id = _pool(seeded_db).id
    create_cashflow(
        seeded_db,
        pool_id=pool_id,
        occurred_on=TODAY,
        direction="OUT",
        nature="BUSINESS_OUT",
        fund_nature="BUSINESS",
        accounting_attribute="OPERATING_EXPENSE",
        category="房租",
        amount=Decimal("30.00"),
        actor="pytest",
    )
    create_cashflow(
        seeded_db,
        pool_id=pool_id,
        occurred_on=TODAY,
        direction="IN",
        nature="BUSINESS_IN",
        fund_nature="BUSINESS",
        accounting_attribute="SELF_REVENUE",
        category="其他收入",
        amount=Decimal("20.00"),
        actor="pytest",
    )

    response = seeded_client.get("/api/v1/reports/data-center", headers=headers)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "sold_cost": "100.00",
        "inventory_cost": "70.00",
        "studio_cost": "30.00",
        "account_sale_profit": "60.00",
        "studio_other_income": "20.00",
        "profit": "80.00",
    }
