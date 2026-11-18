"""STATE-01 orders 域覆盖收口（批2 安全子集）：events.py + service.py 的异常/校验分支守门用例。

仅覆盖 WIP 未触碰的稳定文件（events.py / service.py）；orders/router.py 因 WIP 在改，留待 WIP 落定。
部分内部守卫（_assert_sellable_order / _assert_event_allowed / _get_offset_event / _resolve_pool /
_audit_value / _opposite_direction）直接调用，与 test_orders_common.py 对 _common 的手法一致。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser
from app.domain.enums import Direction
from app.domain.foundation import Pool
from app.domain.trade import Account, Installment, Order, OrderEvent
from app.installments import create as inst_create
from app.installments import recovery as inst_recovery
from app.installments.repayments.pay import pay as inst_pay
from app.orders import events
from app.orders._shared import _audit_value
from app.orders.create import create_order
from app.orders.events import post_event
from app.orders.links import create_order_link
from app.orders.mutations import update_order
from app.orders.queries import list_orders
from app.customer_center.counterparties import create_counterparty
from app.customer_center.customers import create_customer

TODAY = date(2026, 10, 4)
TODAY2 = date(2026, 10, 18)


def _new_account(seeded_db, *, game_account: str = "guard-acc") -> Account:
    account = Account(
        game_account=game_account,
        business_mode="SELF",
        inventory_type="RECOVERY",
        status="WAITING",
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(account)
    seeded_db.commit()
    return account


def _customer(seeded_db, name: str = "甲"):
    return create_customer(seeded_db, display_name=name, actor="pytest")


def _settled_hs_installment(seeded_db):
    account = _new_account(seeded_db, game_account="guard-delivery-account")
    order = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("500"),
        occurred_on=TODAY, actor="pytest",
    )
    inst_create.create_installment(
        seeded_db,
        order_id=order.id,
        contract_type="STOCK_SALE",
        principal=Decimal("600"),
        down_payment=Decimal("100"),
        periods=1,
        per_period=Decimal("500"),
        first_due_on=TODAY,
        actor="pytest",
    )
    contract_id = seeded_db.scalar(
        select(Installment).where(Installment.order_id == order.id)
    ).id
    inst_pay(
        seeded_db, contract_id, amount=Decimal("100"), paid_on=TODAY, period_no=0, actor="pytest"
    )
    inst_pay(
        seeded_db, contract_id, amount=Decimal("500"), paid_on=TODAY, period_no=1, actor="pytest"
    )
    return order


def _delivered_hs_order(seeded_db):
    order = _settled_hs_installment(seeded_db)
    contract = seeded_db.scalar(select(Installment).where(Installment.order_id == order.id))
    inst_recovery.deliver(
        seeded_db, contract.id, delivery_mode="PLATFORM_OPERATOR",
        delivered_on=TODAY, note="换绑凭证", actor="pytest",
    )
    seeded_db.commit()
    return order


# --------------------------------------------------------------------- events.py
def test_removed_cost_event_is_rejected(seeded_db):
    order = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="事件类型必须为"):
        post_event(
            seeded_db, order.id, event_type="COST", amount=Decimal("10"),
            occurred_on=TODAY, actor="pytest",
        )


def test_refund_is_not_an_order_event(seeded_db):
    order = create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    with pytest.raises(Validation, match="事件类型必须为"):
        post_event(
            seeded_db, order.id, event_type="REFUND", amount=Decimal("10"),
            occurred_on=TODAY, actor="pytest",
        )


def test_post_event_rejects_pool_out_of_user_scope(seeded_db):
    order = create_order(
        seeded_db, order_type="TH", trade_date=TODAY, actor="pytest", owner_id=9
    )
    seeded_db.commit()
    restricted = CurrentUser.build(
        id=9, username="guard", roles=["OPERATOR"],
        pool_ids=frozenset(), owner_scope="SELF",
    )
    with pytest.raises(NotFound):
        post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("10"),
            occurred_on=TODAY, actor="pytest", user=restricted,
        )


def test_hs_sell_blocked_when_installment_exists(seeded_db):
    account = _new_account(seeded_db)
    order = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    seeded_db.commit()
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=TODAY, actor="pytest",
    )
    inst_create.create_installment(
        seeded_db, order_id=order.id, contract_type="STOCK_SALE",
        principal=Decimal("100"), down_payment=Decimal("0"), periods=1,
        per_period=Decimal("100"), first_due_on=TODAY, actor="pytest",
    )
    seeded_db.commit()
    with pytest.raises(Validation, match="已建立分期合约"):
        post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("100"),
            occurred_on=TODAY, actor="pytest", portion="PROFIT",
        )


def test_hs_sell_requires_recovered_account(seeded_db):
    order = create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="回收账号售出必须关联已回收的库存账号"):
        post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("100"),
            occurred_on=TODAY, actor="pytest", portion="PROFIT",
        )


def test_hs_sell_requires_account_in_stock(seeded_db):
    account = _new_account(seeded_db)
    account.status = "SOLD"
    seeded_db.commit()
    order = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    seeded_db.commit()
    with pytest.raises(Validation, match="账号必须先完成回收并进入库存"):
        post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("100"),
            occurred_on=TODAY, actor="pytest", portion="PROFIT",
        )


def test_hs_removed_cost_event_does_not_require_account(seeded_db):
    order = create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="事件类型必须为"):
        post_event(
            seeded_db, order.id, event_type="COST", amount=Decimal("10"),
            occurred_on=TODAY, actor="pytest",
        )


def test_th_sell_blocked_when_installment_exists(seeded_db):
    peer = create_counterparty(
        seeded_db, display_name="peer", type="PEER", actor="pytest"
    )
    buyer = _customer(seeded_db)
    seeded_db.commit()
    order = create_order(
        seeded_db, order_type="TH", trade_date=TODAY, actor="pytest",
        customer_roles=[(buyer.id, "BUYER")], counterparty_roles=[(peer.id, "PEER")],
    )
    seeded_db.commit()
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=TODAY, actor="pytest",
    )
    seeded_db.commit()
    # TH 订单仅允许 PICKUP_SALE（STOCK_SALE 仅限 HS），建成分期后应拦 SELL
    inst_create.create_installment(
        seeded_db, order_id=order.id, contract_type="PICKUP_SALE",
        principal=Decimal("100"), down_payment=Decimal("0"), periods=1,
        per_period=Decimal("100"), first_due_on=TODAY, actor="pytest",
    )
    seeded_db.commit()
    with pytest.raises(Validation, match="已建立分期合约，只能通过分期收款"):
        post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("100"),
            occurred_on=TODAY, actor="pytest", portion="PROFIT",
        )


def test_deliver_requires_prior_business_event(seeded_db):
    order = create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="登记卖号交付前必须先登记售出"):
        post_event(
            seeded_db, order.id, event_type="DELIVER", occurred_on=TODAY, actor="pytest",
            delivery_mode="PLATFORM_OPERATOR", note="voucher",
        )


def test_deliver_requires_settled_installment(seeded_db):
    account = _new_account(seeded_db)
    order = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    seeded_db.commit()
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=TODAY, actor="pytest",
    )
    inst_create.create_installment(
        seeded_db, order_id=order.id, contract_type="STOCK_SALE",
        principal=Decimal("100"), down_payment=Decimal("0"), periods=1,
        per_period=Decimal("100"), first_due_on=TODAY, actor="pytest",
    )
    seeded_db.commit()
    with pytest.raises(Validation, match="未结清"):
        post_event(
            seeded_db, order.id, event_type="DELIVER", occurred_on=TODAY, actor="pytest",
            delivery_mode="PLATFORM_OPERATOR", note="voucher",
        )


def test_assert_sellable_rejects_missing_account(seeded_db):
    order = Order(order_type="HS", account_id=999999)
    with pytest.raises(NotFound, match="不存在"):
        events._assert_sellable_order(seeded_db, order)


def test_assert_event_allowed_rejects_buy_without_account_snapshot(seeded_db):
    order = Order(order_type="HS", account_id=None, account_snapshot={})
    with pytest.raises(Validation, match="游戏账号"):
        events._assert_event_allowed(seeded_db, order, "BUY")


def test_opposite_direction_returns_in_for_none(seeded_db):
    assert events._opposite_direction(None, seeded_db) == Direction.IN.value


def test_get_offset_event_rejects_unposted(seeded_db):
    order = create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    unposted = OrderEvent(
        order_id=order.id, event_type="BUY", event_no="EV-GUARD-02", is_posted=False,
        amount=Decimal("0"), portion="PRINCIPAL", occurred_on=TODAY,
        created_by="pytest", updated_by="pytest",
    )
    seeded_db.add(unposted)
    seeded_db.flush()
    with pytest.raises(Validation, match="只能冲销已登记事件"):
        events._get_offset_event(seeded_db, unposted.id, order_id=order.id)


def test_get_offset_event_rejects_non_money_event(seeded_db):
    order = create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    deliver_ev = OrderEvent(
        order_id=order.id, event_type="DELIVER", event_no="EV-GUARD-03", is_posted=True,
        amount=Decimal("0"), portion="PRINCIPAL", occurred_on=TODAY,
        created_by="pytest", updated_by="pytest",
    )
    seeded_db.add(deliver_ev)
    seeded_db.flush()
    with pytest.raises(Validation, match="只能冲销有金额的业务事件"):
        events._get_offset_event(seeded_db, deliver_ev.id, order_id=order.id)


def test_resolve_pool_requires_default_pool(seeded_db):
    unknown_order = Order(order_type="ZZ")
    # 2026-11-17 删除路由后：落账池=唯一默认池；没有任何池时直接拒绝
    for pool in seeded_db.scalars(select(Pool)).all():
        seeded_db.delete(pool)
    seeded_db.flush()
    with pytest.raises(Validation, match="默认资金账户"):
        events._resolve_pool(seeded_db, unknown_order, "PRINCIPAL")


# --------------------------------------------------------------------- service.py
def test_audit_value_serializes_list(seeded_db):
    assert _audit_value([Decimal("1.00"), TODAY]) == ["1.00", TODAY.isoformat()]


def test_update_order_records_date_change(seeded_db):
    order = create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    updated = update_order(
        seeded_db, order.id, actor="pytest", trade_date=TODAY2, note="x", user=None
    )
    assert updated.trade_date == TODAY2


def test_update_order_rejects_account_snapshot(seeded_db):
    order = create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="订单账号快照当前不支持"):
        update_order(
            seeded_db, order.id, actor="pytest",
            account_snapshot={"game_account": "x"}, user=None,
        )


def test_create_order_rejects_invalid_counterparty_role(seeded_db):
    peer = create_counterparty(
        seeded_db, display_name="p", type="PEER", actor="pytest"
    )
    seeded_db.commit()
    with pytest.raises(Validation):
        create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest",
            counterparty_roles=[(peer.id, "INVALID_ROLE")],
        )


def test_create_order_rejects_non_positive_counterparty_id(seeded_db):
    with pytest.raises(Validation):
        create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest",
            counterparty_roles=[(-1, "PEER")],
        )


def test_create_order_rejects_duplicate_counterparty(seeded_db):
    peer = create_counterparty(
        seeded_db, display_name="p", type="PEER", actor="pytest"
    )
    seeded_db.commit()
    with pytest.raises(Validation):
        create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest",
            counterparty_roles=[(peer.id, "PEER"), (peer.id, "PEER")],
        )


def test_create_order_rejects_invalid_owner_id(seeded_db):
    with pytest.raises(Validation):
        create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
            owner_id=-1, user=None,
        )


def test_create_order_link_rejects_split_ratio_over_100(seeded_db):
    o1 = create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    o2 = create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation):
        create_order_link(
            seeded_db, o1.id, related_order_id=o2.id, relation_type="SOURCE",
            split_ratio=Decimal("150"), actor="pytest",
        )


def test_list_orders_filters_by_owner(seeded_db):
    """owner_id 必须真落到 SQL：只返回该负责人的单，别人的单与空值单都不得混入。"""
    mine = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", owner_id=1
    )
    other = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", owner_id=2
    )
    seeded_db.commit()

    rows = list_orders(seeded_db, owner_id=1)

    ids = {row.id for row in rows}
    assert mine.id in ids
    assert other.id not in ids
    assert {row.owner_id for row in rows} == {1}


def test_list_orders_filters_by_pool(seeded_db):
    """pool_id 必须落到 order_events 存在性子查询：只有在该资金账户发生过事件的单才命中。"""
    invest = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
    profit = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_PROFIT"))
    if invest is None or profit is None:
        pytest.fail("种子资金账户缺失")

    acc_hit = _new_account(seeded_db, game_account="guard-pool-hit")
    acc_miss = _new_account(seeded_db, game_account="guard-pool-miss")
    hit = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
        account_id=acc_hit.id,
    )
    miss = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
        account_id=acc_miss.id,
    )
    post_event(
        seeded_db, hit.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=TODAY, actor="pytest", pool_id=invest.id,
    )
    post_event(
        seeded_db, miss.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=TODAY, actor="pytest", pool_id=profit.id,
    )

    rows = list_orders(seeded_db, pool_id=invest.id)

    ids = {row.id for row in rows}
    assert hit.id in ids
    assert miss.id not in ids
