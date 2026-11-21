"""REBATE-01 返点金额契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.funds.rebates import create_rebate
from app.business.inventory.profile import create_account
from app.business.create import create_order
from app.business.events import post_event


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


def test_rebate_amount_is_explicit(seeded_db):
    record = create_rebate(
        seeded_db,
        source_order_id=_order_with_buy(seeded_db),
        rebate_type="BUY",
        amount=Decimal("1000"),
        collected_on=D,
        actor="pytest",
    )

    assert record.amount == Decimal("1000.00")


def test_rebate_expected_arrival_route_removed(app):
    assert "/api/rebates/overdue" not in app.openapi()["paths"]


def test_rebate_legacy_action_routes_removed(app):
    paths = app.openapi()["paths"]
    assert "/api/rebates/{rebate_id}/void" not in paths
    assert "/api/rebates/{rebate_id}/settlements" not in paths
    assert "/api/rebates/{rebate_id}/settlements/{settlement_id}/reverse" not in paths
    # 2026-11-12 裁决：返点登记即确认收入，DELETE 作废入口一并撤销。
    assert "delete" not in paths.get("/api/rebates/{rebate_id}", {})


def test_rebate_delete_service_removed():
    """返点作废服务移除；退回走资金中心录入 OUT 支出，不再 reverse_cashflow+VOID。"""
    import importlib.util

    from app.funds import rebates

    assert not hasattr(rebates, "delete_rebate")
    # 2026-11-12 去兼容：finance.service 再导出门面已删除
    assert importlib.util.find_spec("app.funds.service") is None
