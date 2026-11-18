"""ORDER-01 tests/backend/test_orders：订单、事件、现金流派生（A01 / A02 / A03）。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.stocks.profile import create_account
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.domain.enums import AccountStatus, Direction, EventType, Nature, OrderStatus
from app.domain.foundation import Pool
from app.field_definitions.order_types import get_order_type_by_code
from app.domain.parties import OrderCustomerRole
from app.domain.trade import Account, Cashflow, Installment, Order, OrderEvent
from app.installments import create as inst_create
from app.installments import recovery as inst_recovery
from app.installments.repayments.pay import pay as inst_pay
from app.orders.create import add_customer_role, create_order
from app.orders.events import post_event
from app.customer_center.counterparties import create_counterparty
from app.customer_center.customers import create_customer, set_customer_status

TODAY = date(2026, 10, 4)
TODAY2 = date(2026, 10, 18)


def _new_account(seeded_db, *, game_account: str = "acc-001") -> Account:
    account = Account(
        game_account=game_account,
        business_mode="SELF" if game_account != "th-stock-acc" else "DISTRIBUTION",
        inventory_type="RECOVERY" if game_account != "th-stock-acc" else "PICKUP",
        status=AccountStatus.WAITING.value,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(account)
    seeded_db.commit()
    return account

def _customer(seeded_db, name: str = "甲"):
    return create_customer(seeded_db, display_name=name, actor="pytest")

def _pool(seeded_db, code: str) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == code))
    assert pool is not None
    return pool

def _flows(seeded_db, pool_id: int) -> list[Cashflow]:
    return list(
        seeded_db.scalars(
            select(Cashflow).where(Cashflow.pool_id == pool_id).order_by(Cashflow.id)
        ).all()
    )

def _settled_hs_installment(seeded_db):
    account = _new_account(seeded_db, game_account="delivery-account")
    order = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest", account_id=account.id
    )
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("500"),
        occurred_on=TODAY, actor="pytest",
    )
    contract = inst_create.create_installment(
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
    inst_pay(
        seeded_db, contract.id, amount=Decimal("100"), paid_on=TODAY,
        period_no=0, actor="pytest",
    )
    inst_pay(
        seeded_db, contract.id, amount=Decimal("500"), paid_on=TODAY,
        period_no=1, actor="pytest",
    )
    return order


def _account(seeded_db, *, game_account: str = "b4-acc", status: str = "WAITING") -> Account:
    acc = Account(
        game_account=game_account,
        business_mode="SELF",
        inventory_type="RECOVERY",
        status=status,
        stock_no="KU_B4_" + game_account[-4:].upper(),
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(acc)
    seeded_db.commit()
    return acc

def _hs_order(seeded_db, *, account: Account | None = None) -> Order:
    return create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
        account_id=account.id if account is not None else None,
    )

def _buy(seeded_db, order: Order, *, amount: str = "500", occurred: date = TODAY,
         pool_id: int | None = None):
    return post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal(amount),
        occurred_on=occurred, actor="pytest", pool_id=pool_id,
    )

def _sell(seeded_db, order: Order, *, amount: str = "800", occurred: date = TODAY2,
          pool_id: int | None = None):
    return post_event(
        seeded_db, order.id, event_type="SELL", amount=Decimal(amount),
        occurred_on=occurred, actor="pytest", pool_id=pool_id,
    )


def test_add_customer_role_allows_valid_buyer(seeded_db):
    order = _hs_order(seeded_db)
    cust = create_customer(seeded_db, display_name="正常买家", actor="pytest")
    seeded_db.commit()
    result = add_customer_role(seeded_db, order.id, cust.id, "BUYER", actor="pytest")
    row = seeded_db.scalar(
        select(OrderCustomerRole).where(
            OrderCustomerRole.order_id == order.id,
            OrderCustomerRole.customer_id == cust.id,
            OrderCustomerRole.role == "BUYER",
        )
    )
    assert result.id == order.id
    assert row is not None

def test_add_customer_role_rejects_disabled_customer(seeded_db):
    """停用客户不得作为新订单参与方（原实现缺 assert_customer_usable）。"""
    order = _hs_order(seeded_db)
    cust = create_customer(seeded_db, display_name="停用买家", actor="pytest")
    set_customer_status(seeded_db, cust.id, "DISABLED", actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="不可作为新订单参与方"):
        add_customer_role(seeded_db, order.id, cust.id, "BUYER", actor="pytest")

def test_add_customer_role_rejects_invalid_role(seeded_db):
    order = _hs_order(seeded_db)
    cust = create_customer(seeded_db, display_name="追挂乙", actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="客户角色必须为"):
        add_customer_role(seeded_db, order.id, cust.id, "NOT_A_ROLE", actor="pytest")

def test_add_customer_role_rejects_role_outside_order_type_whitelist(seeded_db):
    """TH 订单仅允许 BUYER，追挂 SELLER 必须被白名单拦截（原实现三元组去重放行）。"""
    th = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest")
    cust = create_customer(seeded_db, display_name="追挂甲", actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="不允许客户角色"):
        add_customer_role(seeded_db, th.id, cust.id, "SELLER", actor="pytest")

def test_deliver_sell_rejects_void_account(seeded_db):
    """DELIVER 不得把 VOID 终态账号直接改回 SOLD（复活）。"""
    acc = _account(seeded_db, game_account="b4-void", status="WAITING")
    order = _hs_order(seeded_db, account=acc)
    seeded_db.commit()
    _buy(seeded_db, order)
    seeded_db.commit()
    # 先登记 SELL（账号 WAITING→SOLD），随后账号因其它原因作废。
    _sell(seeded_db, order)
    acc.status = "VOID"
    seeded_db.commit()
    with pytest.raises(Validation, match="已作废"):
        post_event(
            seeded_db, order.id, event_type="DELIVER", occurred_on=TODAY2,
            actor="pytest", delivery_mode="PLATFORM_OPERATOR", note="换绑凭证",
        )

def test_deliver_sell_uses_state_machine_for_non_sold_account(seeded_db):
    """异常数据（SELL 已登记但账号仍 WAITING）交付时必须走状态机收敛到 SOLD。"""
    acc = _account(seeded_db, game_account="b4-wait", status="WAITING")
    order = _hs_order(seeded_db, account=acc)
    seeded_db.commit()
    _buy(seeded_db, order)
    _sell(seeded_db, order)
    # 模拟账号状态未随 SELL 同步的异常数据。
    acc.status = "WAITING"
    seeded_db.commit()
    post_event(
        seeded_db, order.id, event_type="DELIVER", occurred_on=TODAY2,
        actor="pytest", delivery_mode="PLATFORM_OPERATOR", note="换绑凭证",
    )
    seeded_db.refresh(acc)
    assert acc.status == "SOLD"

def test_reopen_buy_allows_second_sell_closed_loop(seeded_db):
    """COMPLETED → 重开 BUY → ACTIVE → 再次 SELL 必须闭环，不再被「一次 SELL」卡死。"""
    acc = _account(seeded_db, game_account="b4-reopen")
    order = _hs_order(seeded_db, account=acc)
    seeded_db.commit()
    _buy(seeded_db, order, occurred=TODAY)
    _sell(seeded_db, order, occurred=TODAY2)
    seeded_db.refresh(order)
    assert order.status == "COMPLETED"

    # 重开 BUY：COMPLETED → ACTIVE，账号 SOLD → WAITING。
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("450"),
        occurred_on=date(2026, 10, 20), actor="pytest",
    )
    seeded_db.refresh(order)
    seeded_db.refresh(acc)
    assert order.status == "ACTIVE"
    assert acc.status == "WAITING"

    # 再次 SELL：应放行并回到 COMPLETED。
    post_event(
        seeded_db, order.id, event_type="SELL", amount=Decimal("700"),
        occurred_on=date(2026, 10, 22), actor="pytest", portion="PROFIT",
    )
    seeded_db.refresh(order)
    seeded_db.refresh(acc)
    assert order.status == "COMPLETED"
    assert acc.status == "SOLD"
    sells = seeded_db.scalars(
        select(OrderEvent).where(
            OrderEvent.order_id == order.id,
            OrderEvent.event_type == "SELL", OrderEvent.is_posted.is_(True),
        )
    ).all()
    assert len(sells) == 2

def test_second_sell_without_reopen_buy_still_rejected(seeded_db):
    """订单异常回到 ACTIVE、但没有新增 BUY 时，重复 SELL 仍须被拦截。"""
    acc = _account(seeded_db, game_account="b4-dupsell")
    order = _hs_order(seeded_db, account=acc)
    seeded_db.commit()
    _buy(seeded_db, order, occurred=TODAY)
    _sell(seeded_db, order, occurred=TODAY2)
    # 手动把订单拉回 ACTIVE（不带新的 BUY 事件），模拟异常态。
    order.status = "ACTIVE"
    acc.status = "WAITING"
    seeded_db.commit()
    with pytest.raises(Validation, match="重开 BUY"):
        post_event(
            seeded_db, order.id, event_type="SELL", amount=Decimal("700"),
            occurred_on=date(2026, 10, 22), actor="pytest", portion="PROFIT",
        )
