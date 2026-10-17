"""返点服务拆分后的直接契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.accounts import service as accounts_service
from app.finance import rebates
from app.finance import service as finance_service
from app.orders import service as orders_service


TODAY = date(2026, 10, 17)


def _order_with_buy(seeded_db) -> int:
    account = accounts_service.create_account(
        seeded_db,
        game_account="rebate-split-account",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    order = orders_service.create_order(
        seeded_db,
        order_type="HS",
        trade_date=TODAY,
        actor="pytest",
        account_id=account.id,
    )
    orders_service.post_event(
        seeded_db,
        order.id,
        event_type="BUY",
        amount=Decimal("1000"),
        occurred_on=TODAY,
        actor="pytest",
        pool_id=1,
    )
    return order.id


def test_rebate_module_creates_record_directly(seeded_db):
    record = rebates.create_rebate(
        seeded_db,
        source_order_id=_order_with_buy(seeded_db),
        rebate_type="BUY",
        base_amount=Decimal("1000"),
        rate=Decimal("5"),
        collected_on=TODAY,
        actor="pytest",
    )

    assert record.rebate_no.endswith("-RB01")
    assert record.rate == Decimal("5.00")


def test_finance_facade_re_exports_rebate_module_entries():
    assert finance_service.create_rebate is rebates.create_rebate
    assert finance_service.settle_rebate is rebates.settle_rebate
    assert finance_service.get_rebate is rebates.get_rebate
