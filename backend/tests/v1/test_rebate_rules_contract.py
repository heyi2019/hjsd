"""REB-01-07/08 返点规则快照与逾期提醒契约测试。"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from app.finance import service as finance_service
from app.stocks import service as account_service
from app.orders import service as order_service
from app.policy import service as policy_service


D = date(2026, 10, 17)


def _order_with_buy(seeded_db) -> int:
    account = account_service.create_account(
        seeded_db,
        game_account="rebate-rule-account",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    order = order_service.create_order(
        seeded_db,
        order_type="HS",
        owner_id=1,
        trade_date=D,
        actor="pytest",
        account_id=account.id,
    )
    order_service.post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal("1000"),
        occurred_on=D,
        actor="pytest",
        pool_id=1,
    )
    return order.id


def test_rebate_uses_active_rule_rate_when_rate_is_omitted(seeded_db):
    definition = policy_service.create_definition(
        seeded_db,
        policy_code="REBATE",
        name="返点规则",
        scope_type="GLOBAL",
        actor="pytest",
    )
    version = policy_service.create_version(
        seeded_db,
        definition["id"],
        effective_from=D,
        config={"rates": {"BUY": "7.50", "SELL": "3.00"}},
        actor="pytest",
    )
    policy_service.approve_version(seeded_db, version["id"], approver="pytest")

    record = finance_service.create_rebate(
        seeded_db,
        source_order_id=_order_with_buy(seeded_db),
        rebate_type="BUY",
        base_amount=Decimal("1000"),
        collected_on=D,
        actor="pytest",
    )

    assert record.rate == Decimal("7.50")
    assert record.policy_snapshot["config"]["rates"]["BUY"] == "7.50"


def test_overdue_rebate_endpoint_returns_expected_day_and_expected_date(
    seeded_client, seeded_db, headers
):
    record = finance_service.create_rebate(
        seeded_db,
        source_order_id=_order_with_buy(seeded_db),
        rebate_type="BUY",
        base_amount=Decimal("1000"),
        collected_on=D,
        expected_on=D - timedelta(days=7),
        actor="pytest",
        rate=Decimal("5"),
    )

    response = seeded_client.get(
        "/api/v1/rebates/overdue",
        params={"as_of": D.isoformat()},
        headers=headers,
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body) == 1
    assert body[0]["id"] == record.id
    assert body[0]["expected_on"] == "2026-10-10"
    assert body[0]["overdue_days"] == 7


def test_settled_rebate_is_not_overdue(seeded_client, seeded_db, headers):
    record = finance_service.create_rebate(
        seeded_db,
        source_order_id=_order_with_buy(seeded_db),
        rebate_type="BUY",
        base_amount=Decimal("1000"),
        collected_on=D,
        expected_on=D - timedelta(days=1),
        actor="pytest",
        rate=Decimal("5"),
    )
    finance_service.settle_rebate(
        seeded_db,
        record.id,
        gross_amount=Decimal("1000"),
        settled_on=D,
        pool_id=1,
        actor="pytest",
    )

    response = seeded_client.get(
        "/api/v1/rebates/overdue",
        params={"as_of": D.isoformat()},
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json() == []
