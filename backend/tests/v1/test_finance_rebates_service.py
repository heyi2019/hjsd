"""返点服务拆分后的直接契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.accounts import service as accounts_service
from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser
from app.domain.trade import Order, RebateSettlement
from app.finance import rebates
from app.finance import service as finance_service
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


def _order_with_sell(seeded_db) -> int:
    account = accounts_service.create_account(
        seeded_db,
        game_account="dg-rebate-account",
        business_mode="DISTRIBUTION",
        inventory_type="CONSIGNMENT",
        actor="pytest",
    )
    order = orders_service.create_order(
        seeded_db,
        order_type="DG",
        trade_date=TODAY,
        actor="pytest",
        account_id=account.id,
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


def _rebate_and_settlement(seeded_db):
    record = rebates.create_rebate(
        seeded_db,
        source_order_id=_order_with_buy(seeded_db),
        rebate_type="BUY",
        base_amount=Decimal("1000"),
        rate=Decimal("5"),
        collected_on=TODAY,
        actor="pytest",
    )
    settle = rebates.settle_rebate(
        seeded_db, record.id, gross_amount=Decimal("10"),
        settled_on=TODAY, pool_id=1, actor="pytest",
    )
    return record, settle


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
def test_create_rebate_buy_requires_hs(seeded_db):
    order_id = _order_with_sell(seeded_db)  # DG 订单已 ACTIVE
    with pytest.raises(Validation, match="买号返点只能关联回收"):
        rebates.create_rebate(
            seeded_db, source_order_id=order_id, rebate_type="BUY",
            base_amount=Decimal("1000"), rate=Decimal("5"),
            collected_on=TODAY, actor="pytest",
        )  # 77-81


def test_create_rebate_sell_requires_dg(seeded_db):
    order_id = _order_with_buy(seeded_db)  # HS 订单
    with pytest.raises(Validation, match="卖号返点只能关联分销"):
        rebates.create_rebate(
            seeded_db, source_order_id=order_id, rebate_type="SELL",
            base_amount=Decimal("1000"), rate=Decimal("5"),
            collected_on=TODAY, actor="pytest",
        )  # 82-86


# ----------------------------------------------------- settle_rebate 订单不可见 (201-202)
def test_settle_rebate_order_hidden(seeded_db):
    record = rebates.create_rebate(
        seeded_db, source_order_id=_order_with_buy(seeded_db),
        rebate_type="BUY", base_amount=Decimal("1000"), rate=Decimal("5"),
        collected_on=TODAY, actor="pytest",
    )
    with pytest.raises(NotFound):
        rebates.settle_rebate(
            seeded_db, record.id, gross_amount=Decimal("10"),
            settled_on=TODAY, pool_id=1, actor="pytest",
            user=_restricted_user(),
        )  # 199-205


# ----------------------------------------------------- list_rebate_settlements 未知 (336)
def test_list_rebate_settlements_unknown(seeded_db):
    with pytest.raises(NotFound):
        rebates.list_rebate_settlements(seeded_db, 999999)  # 334-339


# ----------------------------------------------------- reverse_rebate_settlement 各类校验
def test_reverse_rebate_settlement_unknown_record(seeded_db):
    with pytest.raises(NotFound):
        rebates.reverse_rebate_settlement(
            seeded_db, 999999, 1, reversed_on=TODAY, actor="pytest", reason="x"
        )  # 368-373


def test_reverse_rebate_settlement_unknown_settlement(seeded_db):
    record = rebates.create_rebate(
        seeded_db, source_order_id=_order_with_buy(seeded_db),
        rebate_type="BUY", base_amount=Decimal("1000"), rate=Decimal("5"),
        collected_on=TODAY, actor="pytest",
    )
    with pytest.raises(NotFound):
        rebates.reverse_rebate_settlement(
            seeded_db, record.id, 999999, reversed_on=TODAY, actor="pytest", reason="x"
        )  # 381-385


def test_reverse_rebate_settlement_already_reversed(seeded_db):
    record, settle = _rebate_and_settlement(seeded_db)
    reversal = rebates.reverse_rebate_settlement(
        seeded_db, record.id, settle.id, reversed_on=TODAY, actor="pytest", reason="x"
    )
    with pytest.raises(Validation, match="冲销记录不能再次冲销"):
        rebates.reverse_rebate_settlement(
            seeded_db, record.id, reversal.id, reversed_on=TODAY, actor="pytest", reason="x"
        )  # 387


def test_reverse_rebate_settlement_missing_cashflow(seeded_db):
    record = rebates.create_rebate(
        seeded_db, source_order_id=_order_with_buy(seeded_db),
        rebate_type="BUY", base_amount=Decimal("1000"), rate=Decimal("5"),
        collected_on=TODAY, actor="pytest",
    )
    settle = RebateSettlement(
        rebate_record_id=record.id, settled_on=TODAY, settlement_no="X-MISSING",
        gross_amount=Decimal("10"), platform_fee=Decimal("0"),
        net_amount=Decimal("10"), cashflow_id=None,
        created_by="pytest", updated_by="pytest",
    )
    seeded_db.add(settle)
    seeded_db.flush()
    with pytest.raises(Validation, match="返点结算缺少资金流水"):
        rebates.reverse_rebate_settlement(
            seeded_db, record.id, settle.id, reversed_on=TODAY, actor="pytest", reason="x"
        )  # 394-395


def test_reverse_rebate_settlement_not_visible(seeded_db):
    from app.domain.trade import Order

    # 受限用户用已存在的用户 id=2（满足 orders.owner_id 外键），
    # 但池授权为空：能看订单、看不到现金流所在资金池 1，从而触发 400。
    vis_user = CurrentUser(
        id=2, username="vis", roles=(), owner_scope="SELF", pool_ids=frozenset()
    )
    order_id = _order_with_buy(seeded_db)
    order = seeded_db.get(Order, order_id)
    order.owner_id = 2
    seeded_db.flush()
    record = rebates.create_rebate(
        seeded_db, source_order_id=order_id, rebate_type="BUY",
        base_amount=Decimal("1000"), rate=Decimal("5"),
        collected_on=TODAY, actor="pytest",
    )
    settle = rebates.settle_rebate(
        seeded_db, record.id, gross_amount=Decimal("10"),
        settled_on=TODAY, pool_id=1, actor="pytest",
    )
    with pytest.raises(NotFound):
        rebates.reverse_rebate_settlement(
            seeded_db, record.id, settle.id, reversed_on=TODAY, actor="pytest",
            reason="x", user=vis_user,
        )  # 399-400


# 注：398 / 432 为外键保证不可达的防御分支（cashflow_id / fee_cashflow_id
# 均带指向 cashflows.id 的外键，运行时测试库 FK 开启，不存在悬空引用）；
# 与 reconciliation L153 纯逻辑死代码不同，此处是依赖 FK 的有效防御，保留不删。


# ----------------------------------------------------- list_overdue_rebates 作用域 (516-518)
def test_list_overdue_rebates_scoped(seeded_db):
    assert rebates.list_overdue_rebates(
        seeded_db, as_of=TODAY, user=_restricted_user()
    ) == []  # 516-518


# ----------------------------------------------------- sync 跳过无负责人订单 (537-539)
def test_sync_overdue_rebate_notifications_skips_ownerless(seeded_db):
    order_id = _order_with_buy(seeded_db)
    order = seeded_db.get(Order, order_id)
    order.owner_id = None
    seeded_db.flush()
    rebates.create_rebate(
        seeded_db, source_order_id=order_id, rebate_type="BUY",
        base_amount=Decimal("1000"), rate=Decimal("5"),
        expected_on=date(2026, 10, 1), collected_on=TODAY, actor="pytest",
    )
    result = rebates.sync_overdue_rebate_notifications(seeded_db, as_of=TODAY, actor="pytest")
    assert result["skipped"] == 1  # 537-539


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
