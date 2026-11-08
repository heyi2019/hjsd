"""STATE-01 orders 域的事件校验、权限边界和状态守卫。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import NotFound, Validation
from app.core.security import CurrentUser
from app.domain.foundation import Pool
from app.domain.trade import Account, Installment, OrderEvent
from app.value_added_services import service as installment_service
from app.orders import events, service
from app.parties import service as parties_service

TODAY = date(2026, 10, 4)
TODAY2 = date(2026, 10, 18)


def _new_account(seeded_db, *, game_account: str = "guard-acc") -> Account:
    account = Account(
        game_account=game_account,
        platform="王者",
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
    return parties_service.create_customer(seeded_db, display_name=name, actor="pytest")


def _settled_hs_installment(seeded_db):
    account = _new_account(seeded_db, game_account="guard-delivery-account")
    order = service.create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    service.post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("500"),
        occurred_on=TODAY, actor="pytest",
    )
    installment_service.create_installment(
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
    installment_service.pay(
        seeded_db, contract_id, amount=Decimal("100"), paid_on=TODAY, period_no=0, actor="pytest"
    )
    installment_service.pay(
        seeded_db, contract_id, amount=Decimal("500"), paid_on=TODAY, period_no=1, actor="pytest"
    )
    return order


def _delivered_hs_order(seeded_db):
    order = _settled_hs_installment(seeded_db)
    contract = seeded_db.scalar(select(Installment).where(Installment.order_id == order.id))
    installment_service.deliver(
        seeded_db, contract.id, delivery_mode="PLATFORM_OPERATOR",
        delivered_on=TODAY, note="换绑凭证", actor="pytest",
    )
    seeded_db.commit()
    return order


# --------------------------------------------------------------------- events.py
def test_defer_order_cancel_requires_installment_cancel_flag(seeded_db):
    order = service.create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="defer_order_cancel 只能用于分期取消流程"):
        service.post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("10"),
            occurred_on=TODAY, actor="pytest", defer_order_cancel=True,
        )


def test_refund_rejects_invalid_responsibility(seeded_db):
    order = _delivered_hs_order(seeded_db)
    with pytest.raises(Validation, match="退款责任方必须为"):
        service.post_event(
            seeded_db, order.id, event_type="REFUND", amount=Decimal("10"),
            occurred_on=TODAY, actor="pytest", reason="x", refund_responsibility="BAD",
        )


def test_refund_rejects_offset_event_id(seeded_db):
    order = _delivered_hs_order(seeded_db)
    with pytest.raises(Validation, match="退款不使用 offset_event_id"):
        service.post_event(
            seeded_db, order.id, event_type="REFUND", amount=Decimal("10"),
            occurred_on=TODAY, actor="pytest", reason="x",
            refund_responsibility="COMPANY", offset_event_id=1,
        )


def test_post_event_rejects_pool_out_of_user_scope(seeded_db):
    order = service.create_order(
        seeded_db, order_type="TH", trade_date=TODAY, actor="pytest", owner_id=9
    )
    seeded_db.commit()
    restricted = CurrentUser.build(
        id=9, username="guard", roles=["OPERATOR"],
        pool_ids=frozenset(), owner_scope="SELF",
    )
    with pytest.raises(NotFound):
        service.post_event(
            seeded_db, order.id, event_type="BUY", amount=Decimal("10"),
            occurred_on=TODAY, actor="pytest", user=restricted,
        )


def test_hs_sell_blocked_when_installment_exists(seeded_db):
    account = _new_account(seeded_db)
    order = service.create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    seeded_db.commit()
    service.post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=TODAY, actor="pytest",
    )
    installment_service.create_installment(
        seeded_db, order_id=order.id, contract_type="STOCK_SALE",
        principal=Decimal("100"), down_payment=Decimal("0"), periods=1,
        per_period=Decimal("100"), first_due_on=TODAY, actor="pytest",
    )
    seeded_db.commit()
    with pytest.raises(Validation, match="已建立分期合约"):
        service.post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("100"),
            occurred_on=TODAY, actor="pytest", portion="PROFIT",
        )


def test_hs_sell_requires_recovered_account(seeded_db):
    order = service.create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="自营账号售出必须关联已回收账号"):
        service.post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("100"),
            occurred_on=TODAY, actor="pytest", portion="PROFIT",
        )


def test_hs_sell_requires_account_in_stock(seeded_db):
    account = _new_account(seeded_db)
    account.status = "SOLD"
    seeded_db.commit()
    order = service.create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    seeded_db.commit()
    with pytest.raises(Validation, match="账号必须先完成回收并进入库存"):
        service.post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("100"),
            occurred_on=TODAY, actor="pytest", portion="PROFIT",
        )


def test_hs_cost_requires_account(seeded_db):
    order = service.create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="回收订单 COST 必须关联库存账号"):
        service.post_event(
            seeded_db, order.id, event_type="COST", amount=Decimal("10"),
            occurred_on=TODAY, actor="pytest",
        )


def test_th_sell_blocked_when_installment_exists(seeded_db):
    supplier = parties_service.create_counterparty(
        seeded_db, display_name="供货方", type="SUPPLIER", actor="pytest"
    )
    seeded_db.commit()
    order = service.create_order(
        seeded_db, order_type="TH", trade_date=TODAY, actor="pytest",
        counterparty_roles=[(supplier.id, "SUPPLIER")],
    )
    seeded_db.commit()
    service.post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=TODAY, actor="pytest",
    )
    seeded_db.commit()
    # TH 订单仅允许 PICKUP_SALE（STOCK_SALE 仅限 HS），建成分期后应拦 SELL
    installment_service.create_installment(
        seeded_db, order_id=order.id, contract_type="PICKUP_SALE",
        principal=Decimal("100"), down_payment=Decimal("0"), periods=1,
        per_period=Decimal("100"), first_due_on=TODAY, actor="pytest",
    )
    seeded_db.commit()
    with pytest.raises(Validation, match="已建立分期合约，只能通过 PAYMENT 收款"):
        service.post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("100"),
            occurred_on=TODAY, actor="pytest", portion="PROFIT",
        )


def test_deliver_requires_installment(seeded_db):
    order = service.create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="必须通过分期合约交付"):
        service.post_event(
            seeded_db, order.id, event_type="DELIVER", occurred_on=TODAY, actor="pytest",
            delivery_mode="PLATFORM_OPERATOR", note="voucher",
        )


def test_deliver_requires_settled_installment(seeded_db):
    account = _new_account(seeded_db)
    order = service.create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    seeded_db.commit()
    service.post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=TODAY, actor="pytest",
    )
    installment_service.create_installment(
        seeded_db, order_id=order.id, contract_type="STOCK_SALE",
        principal=Decimal("100"), down_payment=Decimal("0"), periods=1,
        per_period=Decimal("100"), first_due_on=TODAY, actor="pytest",
    )
    seeded_db.commit()
    with pytest.raises(Validation, match="未结清"):
        service.post_event(
            seeded_db, order.id, event_type="DELIVER", occurred_on=TODAY, actor="pytest",
            delivery_mode="PLATFORM_OPERATOR", note="voucher",
        )


def test_assert_event_allowed_rejects_payment_offset_without_installment(seeded_db):
    order = service.create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    payment_event = OrderEvent(
        order_id=order.id, event_type="PAYMENT", event_no="EV-GUARD-01", is_posted=True,
        amount=Decimal("0"), portion="PRINCIPAL", occurred_on=TODAY,
        created_by="pytest", updated_by="pytest",
    )
    seeded_db.add(payment_event)
    seeded_db.flush()
    with pytest.raises(Validation, match="PAYMENT 冲销必须关联分期合约"):
        events._assert_event_allowed(
            seeded_db, order, "CANCEL", offset_event_id=payment_event.id,
            reason="x", allow_installment_cancel=True,
        )


def test_get_offset_event_rejects_unposted(seeded_db):
    order = service.create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
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
    order = service.create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
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


# --------------------------------------------------------------------- service.py
def test_audit_value_serializes_list(seeded_db):
    assert service._audit_value([Decimal("1.00"), TODAY]) == ["1.00", TODAY.isoformat()]


def test_update_order_records_date_change(seeded_db):
    order = service.create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    updated = service.update_order(
        seeded_db, order.id, actor="pytest", trade_date=TODAY2, note="x", user=None
    )
    assert updated.trade_date == TODAY2


def test_update_order_accepts_account_snapshot(seeded_db):
    """账号快照一律可编辑。"""
    order = service.create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    updated = service.update_order(
        seeded_db, order.id, actor="pytest",
        account_snapshot={"game_account": "x", "game_type": "王者荣耀"}, user=None,
    )
    assert updated.account_snapshot == {"game_account": "x", "game_type": "王者荣耀"}


def test_create_order_rejects_invalid_counterparty_role(seeded_db):
    peer = parties_service.create_counterparty(
        seeded_db, display_name="p", type="PEER", actor="pytest"
    )
    seeded_db.commit()
    with pytest.raises(Validation):
        service.create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest",
            counterparty_roles=[(peer.id, "INVALID_ROLE")],
        )


def test_create_order_rejects_non_positive_counterparty_id(seeded_db):
    with pytest.raises(Validation):
        service.create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest",
            counterparty_roles=[(-1, "SUPPLIER")],
        )


def test_create_order_rejects_duplicate_counterparty(seeded_db):
    supplier = parties_service.create_counterparty(
        seeded_db, display_name="p", type="SUPPLIER", actor="pytest"
    )
    seeded_db.commit()
    with pytest.raises(Validation):
        service.create_order(
            seeded_db, order_type="TH", trade_date=TODAY, actor="pytest",
            counterparty_roles=[(supplier.id, "SUPPLIER"), (supplier.id, "SUPPLIER")],
        )


def test_create_order_rejects_invalid_owner_id(seeded_db):
    with pytest.raises(Validation):
        service.create_order(
            seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
            owner_id=-1, user=None,
        )


def test_create_order_link_rejects_split_ratio_over_100(seeded_db):
    o1 = service.create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    o2 = service.create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation):
        service.create_order_link(
            seeded_db, o1.id, related_order_id=o2.id, relation_type="SOURCE",
            split_ratio=Decimal("150"), actor="pytest",
        )


def test_list_orders_filters_by_owner(seeded_db):
    """owner_id 必须真落到 SQL：只返回该负责人的单，别人的单与空值单都不得混入。"""
    mine = service.create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", owner_id=1
    )
    other = service.create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", owner_id=2
    )
    seeded_db.commit()

    rows = service.list_orders(seeded_db, owner_id=1)

    ids = {row.id for row in rows}
    assert mine.id in ids
    assert other.id not in ids
    assert {row.owner_id for row in rows} == {1}


def test_list_orders_filters_by_pool(seeded_db):
    """pool_id 必须落到 order_events 存在性子查询：只有在该资金账户发生过事件的单才命中。"""
    invest = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
    profit = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_PROFIT"))
    if invest is None or profit is None:
        pytest.fail("种子资金池缺失")

    acc_hit = _new_account(seeded_db, game_account="guard-pool-hit")
    acc_miss = _new_account(seeded_db, game_account="guard-pool-miss")
    hit = service.create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
        account_id=acc_hit.id,
    )
    miss = service.create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
        account_id=acc_miss.id,
    )
    service.post_event(
        seeded_db, hit.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=TODAY, actor="pytest", pool_id=invest.id,
    )
    service.post_event(
        seeded_db, miss.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=TODAY, actor="pytest", pool_id=profit.id,
    )

    rows = service.list_orders(seeded_db, pool_id=invest.id)

    ids = {row.id for row in rows}
    assert hit.id in ids
    assert miss.id not in ids


def test_update_order_applies_extra_values_when_provided(seeded_db):
    # 触发 update_order 的 extra_values 分支（685-691 行）；空字典仍进入分支并调用 set_extra_values
    order = service.create_order(seeded_db, order_type="HS", trade_date=TODAY, actor="pytest")
    seeded_db.commit()
    updated = service.update_order(
        seeded_db, order.id, actor="pytest", extra_values={}, user=None
    )
    assert updated.id == order.id
