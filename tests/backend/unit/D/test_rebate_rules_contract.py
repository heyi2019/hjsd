"""REBATE-01 返点规则快照契约测试。"""
from __future__ import annotations

from datetime import date
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
    policy_service.create_version(
        seeded_db,
        definition["id"],
        effective_from=D,
        config={"rates": {"BUY": "7.50", "SELL": "3.00"}},
        actor="pytest",
    )

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
    assert record.status == "SETTLED"


def test_rebate_expected_arrival_route_removed(app):
    assert "/api/v1/rebates/overdue" not in app.openapi()["paths"]


def test_rebate_legacy_action_routes_removed(app):
    paths = app.openapi()["paths"]
    assert "/api/v1/rebates/{rebate_id}/void" not in paths
    assert "/api/v1/rebates/{rebate_id}/settlements" not in paths
    assert "/api/v1/rebates/{rebate_id}/settlements/{settlement_id}/reverse" not in paths
