"""REBATE-01 返点服务拆分后的直接契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.stocks import service as stocks_service
from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser
from app.finance import rebates
from app.finance.rebates import _rebate_rate_from_snapshot
from app.orders import service as orders_service


TODAY = date(2026, 10, 17)


def _restricted_user() -> CurrentUser:
    return CurrentUser(
        id=999,
        username="restricted",
        roles=(),
        permissions=frozenset(),
        pool_ids=frozenset(),
        owner_scope="SELF",
    )


def _all_scope_user() -> CurrentUser:
    return CurrentUser(
        id=1,
        username="allscope",
        roles=(),
        owner_scope="ALL",
        pool_ids=frozenset(),
    )


_ACCOUNT_CONTEXT = {
    "HS": ("SELF", "RECOVERY"),
    "TH": ("DISTRIBUTION", "PICKUP"),
    "DG": ("DISTRIBUTION", "CONSIGNMENT"),
}


def _order_with_buy(seeded_db, order_type: str = "HS") -> int:
    business_mode, inventory_type = _ACCOUNT_CONTEXT[order_type]
    account = stocks_service.create_account(
        seeded_db,
        game_account=f"rebate-buy-{order_type.lower()}",
        business_mode=business_mode,
        inventory_type=inventory_type,
        actor="pytest",
    )
    order = orders_service.create_order(
        seeded_db,
        order_type=order_type,
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


def _order_with_sell(seeded_db, order_type: str = "DG") -> int:
    business_mode, inventory_type = _ACCOUNT_CONTEXT[order_type]
    account = stocks_service.create_account(
        seeded_db,
        game_account=f"{order_type.lower()}-sell-rebate-account",
        business_mode=business_mode,
        inventory_type=inventory_type,
        actor="pytest",
    )
    order = orders_service.create_order(
        seeded_db,
        order_type=order_type,
        trade_date=TODAY,
        actor="pytest",
        account_id=account.id,
    )
    if order_type == "HS":
        # 回收单 SELL 前必须有采购入库（BUY）事件。
        orders_service.post_event(
            seeded_db, order.id, event_type="BUY",
            amount=Decimal("1000"), occurred_on=TODAY, actor="pytest", pool_id=1,
        )
    orders_service.post_event(
        seeded_db,
        order.id,
        event_type="SELL",
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


# ----------------------------------------------------- 费率快照解析分支
def test_rate_from_snapshot_config_not_dict():
    assert _rebate_rate_from_snapshot({"config": "nope"}, "BUY") is None  # 165-166


def test_rate_from_snapshot_rates_dict_branch():
    assert _rebate_rate_from_snapshot(
        {"config": {"rates": {"BUY": "5"}}}, "BUY"
    ) == Decimal("5.00")  # 168 字典分支


def test_rate_from_snapshot_fallback_rate():
    assert _rebate_rate_from_snapshot(
        {"config": {"rate": "5"}}, "BUY"
    ) == Decimal("5.00")  # 168-170 回退到 config.rate


def test_rate_from_snapshot_no_rate():
    assert _rebate_rate_from_snapshot({"config": {}}, "BUY") is None  # 170-172


def test_rate_from_snapshot_bad_value():
    with pytest.raises(Validation, match="费率必须是数值"):
        _rebate_rate_from_snapshot({"config": {"rate": "abc"}}, "BUY")  # 173-176


# ----------------------------------------------------- 返点类型与订单类型约束
def test_create_rebate_buy_rejects_dg(seeded_db):
    order_id = _order_with_sell(seeded_db)  # DG 订单已 ACTIVE
    with pytest.raises(Validation, match="买号返点只能关联回收、提号订单"):
        rebates.create_rebate(
            seeded_db, source_order_id=order_id, rebate_type="BUY",
            base_amount=Decimal("1000"), rate=Decimal("5"),
            collected_on=TODAY, actor="pytest",
        )  # 买号返点仅限 HS/TH，DG 不可


def test_create_rebate_buy_allows_th(seeded_db):
    """TH（提号）订单有 BUY 事件即可登记买号返点（2026-10-28 口径放开）。"""
    order_id = _order_with_buy(seeded_db, order_type="TH")
    record = rebates.create_rebate(
        seeded_db, source_order_id=order_id, rebate_type="BUY",
        base_amount=Decimal("1000"), rate=Decimal("5"),
        collected_on=TODAY, actor="pytest",
    )
    assert record.rebate_type == "BUY"


def test_create_rebate_sell_allows_created_order_without_sell_event(seeded_db):
    order_id = _order_with_buy(seeded_db)  # HS 订单只有 BUY 事件
    record = rebates.create_rebate(
        seeded_db, source_order_id=order_id, rebate_type="SELL",
        base_amount=Decimal("1000"), rate=Decimal("5"),
        collected_on=TODAY, actor="pytest",
    )
    assert record.rebate_type == "SELL"


def test_create_rebate_sell_allows_hs_with_sell_event(seeded_db):
    """2026-10-28 口径：卖号返点不再限 DG，回收单有 SELL 事件即可。"""
    order_id = _order_with_sell(seeded_db, order_type="HS")
    record = rebates.create_rebate(
        seeded_db, source_order_id=order_id, rebate_type="SELL",
        base_amount=Decimal("1000"), rate=Decimal("5"),
        collected_on=TODAY, actor="pytest",
    )
    assert record.rebate_type == "SELL"


# ----------------------------------------------------- get_rebate 作用域 (571-586)
def test_get_rebate_no_user(seeded_db):
    record = rebates.create_rebate(
        seeded_db, source_order_id=_order_with_buy(seeded_db),
        rebate_type="BUY", base_amount=Decimal("1000"), rate=Decimal("5"),
        collected_on=TODAY, actor="pytest",
    )
    assert rebates.get_rebate(seeded_db, record.id) is record


def test_get_rebate_scope_hidden(seeded_db):
    record = rebates.create_rebate(
        seeded_db, source_order_id=_order_with_buy(seeded_db),
        rebate_type="BUY", base_amount=Decimal("1000"), rate=Decimal("5"),
        collected_on=TODAY, actor="pytest",
    )
    with pytest.raises(NotFound):
        rebates.get_rebate(seeded_db, record.id, user=_restricted_user())  # 574-585


def test_get_rebate_unknown(seeded_db):
    with pytest.raises(NotFound):
        rebates.get_rebate(seeded_db, 999999)  # 571-573
