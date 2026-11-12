"""REBATE-01 返点规则快照契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.finance.rebates import create_rebate
from app.stocks.profile import create_account
from app.orders.create import create_order
from app.orders.events import post_event
from app.policy import definitions as policy_definitions
from app.policy import versions as policy_versions


D = date(2026, 10, 17)


def _order_with_buy(seeded_db) -> int:
    account = create_account(
        seeded_db,
        game_account="rebate-rule-account",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    order = create_order(
        seeded_db,
        order_type="HS",
        owner_id=1,
        trade_date=D,
        actor="pytest",
        account_id=account.id,
    )
    post_event(
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
    definition = policy_definitions.create_definition(
        seeded_db,
        policy_code="REBATE",
        name="返点规则",
        scope_type="GLOBAL",
        actor="pytest",
    )
    policy_versions.create_version(
        seeded_db,
        definition["id"],
        effective_from=D,
        config={"rates": {"BUY": "7.50", "SELL": "3.00"}},
        actor="pytest",
    )

    record = create_rebate(
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
    # 2026-11-12 裁决：返点登记即确认收入，DELETE 作废入口一并撤销。
    assert "delete" not in paths.get("/api/v1/rebates/{rebate_id}", {})


def test_rebate_delete_service_removed():
    """返点作废服务移除；退回走资金中心录入 OUT 支出，不再 reverse_cashflow+VOID。"""
    import importlib.util

    from app.finance import rebates

    assert not hasattr(rebates, "delete_rebate")
    # 2026-11-12 去兼容：finance.service 再导出门面已删除
    assert importlib.util.find_spec("app.finance.service") is None
