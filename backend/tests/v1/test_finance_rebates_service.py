"""返点服务拆分后的直接契约测试。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app.stocks import service as stocks_service
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


@pytest.mark.skip(reason="返点结算服务已删除")
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
def test_create_rebate_buy_requires_hs_th_dfq(seeded_db):
    order_id = _order_with_sell(seeded_db)  # DG 订单已 ACTIVE
    with pytest.raises(Validation, match="买号返点只能关联回收、提号或代分期"):
        rebates.create_rebate(
            seeded_db, source_order_id=order_id, rebate_type="BUY",
            base_amount=Decimal("1000"), rate=Decimal("5"),
            collected_on=TODAY, actor="pytest",
        )  # 买号返点仅限 HS/TH/DFQ（代分期为垫资买入），DG 不可


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


def test_create_rebate_sell_dfq_allows_created_order(seeded_db):
    """DFQ 创建订单后即可登记卖号返点。"""
    order = orders_service.create_order(
        seeded_db, order_type="DFQ", trade_date=TODAY, actor="pytest",
    )
    record = rebates.create_rebate(
        seeded_db, source_order_id=order.id, rebate_type="SELL",
        base_amount=Decimal("1000"), rate=Decimal("5"),
        collected_on=TODAY, actor="pytest",
    )
    assert record.rebate_type == "SELL"


# ----------------------------------------------------- settle_rebate 订单不可见 (201-202)
@pytest.mark.skip(reason="返点结算服务已删除")
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
@pytest.mark.skip(reason="返点结算服务已删除")
def test_list_rebate_settlements_unknown(seeded_db):
    with pytest.raises(NotFound):
        rebates.list_rebate_settlements(seeded_db, 999999)  # 334-339


# ----------------------------------------------------- reverse_rebate_settlement 各类校验
@pytest.mark.skip(reason="返点冲销服务已删除")
def test_reverse_rebate_settlement_unknown_record(seeded_db):
    with pytest.raises(NotFound):
        rebates.reverse_rebate_settlement(
            seeded_db, 999999, 1, reversed_on=TODAY, actor="pytest", reason="x"
        )  # 368-373


@pytest.mark.skip(reason="返点冲销服务已删除")
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


@pytest.mark.skip(reason="返点冲销服务已删除")
def test_reverse_rebate_settlement_already_reversed(seeded_db):
    record, settle = _rebate_and_settlement(seeded_db)
    reversal = rebates.reverse_rebate_settlement(
        seeded_db, record.id, settle.id, reversed_on=TODAY, actor="pytest", reason="x"
    )
    with pytest.raises(Validation, match="冲销记录不能再次冲销"):
        rebates.reverse_rebate_settlement(
            seeded_db, record.id, reversal.id, reversed_on=TODAY, actor="pytest", reason="x"
        )  # 387


@pytest.mark.skip(reason="返点冲销服务已删除")
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


@pytest.mark.skip(reason="返点冲销服务已删除")
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


# 注：429 / 463 为外键保证的防御分支（cashflow_id / fee_cashflow_id 指向
# cashflows.id；运行时测试库 FK 开启，常规 ORM 插入造不出悬空引用，故看似不可达）。
# 与 reconciliation L153 纯逻辑死代码不同，此处是依赖 FK 的有效防御，保留不删；
# 已由原生 sqlite3 连接绕过 FK 造脏态覆盖（见 test_finance_reporting_task5_tail.py 的
# test_reverse_settlement_missing_cashflow_row / _missing_fee_cashflow_row）。


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
