"""ROBUST-01 批次四：订单域 7 条逻辑缺陷回归（#11/#12/#13/#15/#16/#17/#19）。

口径锚点（用户 11-12 裁决）：利润 = 收入大类 − 支出大类；本文件覆盖参与方护栏、
分润绑定、资金池筛选、账号状态机、重开 BUY 闭环、表单依赖与作用域注册。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.errors import Validation
from app.domain.foundation import Pool
from app.domain.parties import OrderCustomerRole
from app.domain.trade import (
    Account,
    Cashflow,
    Order,
    OrderEvent,
    OrderFormField,
    OrderProfitAllocation,
)
from app.domain.users import User
from app.orders import form_fields as ff
from app.orders.create import add_customer_role, create_order
from app.orders.events import post_event
from app.orders.queries import count_orders, list_orders
from app.parties.customers import create_customer, set_customer_status

TODAY = date(2026, 10, 4)
TODAY2 = date(2026, 10, 18)


def _account(seeded_db, *, game_account: str = "b4-acc", status: str = "WAITING") -> Account:
    acc = Account(
        game_account=game_account,
        platform="王者",
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
          pool_id: int | None = None, pool_id2: int | None = None, amount2: str | None = None):
    kw = {}
    if pool_id2 is not None:
        kw["pool_id2"] = pool_id2
        kw["amount2"] = Decimal(amount2 or "300")
    return post_event(
        seeded_db, order.id, event_type="SELL", amount=Decimal(amount),
        occurred_on=occurred, actor="pytest", pool_id=pool_id, **kw,
    )


# ---------------------------------------------------------------- #11 角色护栏
def test_add_customer_role_rejects_role_outside_order_type_whitelist(seeded_db):
    """TH 订单仅允许 BUYER，追挂 SELLER 必须被白名单拦截（原实现三元组去重放行）。"""
    th = create_order(seeded_db, order_type="TH", trade_date=TODAY, actor="pytest")
    cust = create_customer(seeded_db, display_name="追挂甲", actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="不允许客户角色"):
        add_customer_role(seeded_db, th.id, cust.id, "SELLER", actor="pytest")


def test_add_customer_role_rejects_invalid_role(seeded_db):
    order = _hs_order(seeded_db)
    cust = create_customer(seeded_db, display_name="追挂乙", actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="客户角色必须为"):
        add_customer_role(seeded_db, order.id, cust.id, "NOT_A_ROLE", actor="pytest")


def test_add_customer_role_rejects_disabled_customer(seeded_db):
    """停用客户不得作为新订单参与方（原实现缺 assert_customer_usable）。"""
    order = _hs_order(seeded_db)
    cust = create_customer(seeded_db, display_name="停用买家", actor="pytest")
    set_customer_status(seeded_db, cust.id, "DISABLED", actor="pytest")
    seeded_db.commit()
    with pytest.raises(Validation, match="不可作为新订单参与方"):
        add_customer_role(seeded_db, order.id, cust.id, "BUYER", actor="pytest")


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


# ---------------------------------------------------------------- #12 多人分润
def test_sell_event_does_not_overwrite_multi_person_allocation(seeded_db):
    """SELL 事件只兜底「单行未绑定」，不得把多人分润的 user_id 全抹成当前执行人。"""
    acc = _account(seeded_db, game_account="b4-alloc")
    order = _hs_order(seeded_db, account=acc)
    seeded_db.commit()
    _buy(seeded_db, order)
    seeded_db.commit()

    # 造两行 SELL 分润，分别绑定用户 1 / 用户 2（模拟多人协作各占一行）。
    seeded_db.add_all([
        OrderProfitAllocation(
            order_id=order.id, user_id=1, role="OWNER", allocation_type="SELL",
            allocation_rate=Decimal("15"), allocation_amount=Decimal("0"),
        ),
        OrderProfitAllocation(
            order_id=order.id, user_id=2, role="SALES", allocation_type="SELL",
            allocation_rate=Decimal("10"), allocation_amount=Decimal("0"),
        ),
    ])
    seeded_db.commit()

    _sell(seeded_db, order)

    rows = seeded_db.scalars(
        select(OrderProfitAllocation).where(
            OrderProfitAllocation.order_id == order.id,
            OrderProfitAllocation.allocation_type == "SELL",
        )
    ).all()
    # 修复前：两行都被改成执行人 pytest 的 id；修复后：各自保留。
    assert {row.user_id for row in rows} == {1, 2}


def test_sell_event_backfills_single_unbound_allocation(seeded_db):
    """历史兜底仍在：该动作类型恰好单行且未绑定人员时回填当前执行人。"""
    acc = _account(seeded_db, game_account="b4-alloc1")
    order = _hs_order(seeded_db, account=acc)
    seeded_db.commit()
    _buy(seeded_db, order)
    seeded_db.commit()
    seeded_db.add(
        OrderProfitAllocation(
            order_id=order.id, user_id=None, role="OWNER", allocation_type="SELL",
            allocation_rate=Decimal("25"), allocation_amount=Decimal("0"),
        )
    )
    seeded_db.commit()
    # actor 需对应种子里的真实用户（seeduser1），events.py 以 username 反查 id 回填。
    actor_id = seeded_db.scalar(select(User.id).where(User.username == "seeduser1"))
    post_event(
        seeded_db, order.id, event_type="SELL", amount=Decimal("800"),
        occurred_on=TODAY2, actor="seeduser1",
    )
    row = seeded_db.scalar(
        select(OrderProfitAllocation).where(
            OrderProfitAllocation.order_id == order.id,
            OrderProfitAllocation.allocation_type == "SELL",
        )
    )
    assert row.user_id == actor_id


# ---------------------------------------------------------------- #13 资金池筛选
def test_pool_filter_matches_secondary_split_pool(seeded_db):
    """售出拆分第二池的流水挂在 Cashflow.pool_id，按第二池筛订单/计数必须命中。"""
    invest = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
    profit = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_PROFIT"))
    assert invest is not None and profit is not None

    acc = _account(seeded_db, game_account="b4-split")
    order = _hs_order(seeded_db, account=acc)
    seeded_db.commit()
    _buy(seeded_db, order, pool_id=invest.id)
    # 主池进 invest，第二池进 profit；OrderEvent 只记主池。
    _sell(seeded_db, order, pool_id=invest.id, pool_id2=profit.id, amount2="300")

    secondary = seeded_db.scalars(
        select(Cashflow).where(
            Cashflow.order_id == order.id, Cashflow.pool_id == profit.id,
            Cashflow.order_event_id.is_not(None),
        )
    ).all()
    assert secondary, "售出拆分第二池流水应落在 profit 池"

    by_second = {r.id for r in list_orders(seeded_db, pool_id=profit.id)}
    assert order.id in by_second, "按第二池筛选必须命中该订单"
    assert count_orders(seeded_db, pool_id=profit.id) >= 1


# ---------------------------------------------------------------- #15 账号状态机
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


# ---------------------------------------------------------------- #16 重开 BUY 闭环
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
    """没有重开 BUY 的重复 SELL 仍须被拦截（回归不要放松成完全放行）。"""
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


# ---------------------------------------------------------------- #17 依赖停用
def test_required_when_rejects_inactive_dependency(seeded_db):
    """条件必填不得依赖已停用字段（写入时即拒绝，避免静默失效）。"""
    ff.create_order_form_field(
        seeded_db, order_type_code="HS", field_key="dep_inactive", label="已停用来源",
        actor="admin", field_type="SELECT",
        options=[{"value": "其他", "label": "其他"}],
    )
    seeded_db.commit()
    ff.set_order_form_field_active(seeded_db,
        seeded_db.scalar(
            select(OrderFormField).where(
                OrderFormField.order_type_code == "HS",
                OrderFormField.field_key == "dep_inactive",
            )
        ).id,
        False, actor="admin",
    )
    seeded_db.commit()
    with pytest.raises(Validation, match="不存在或已停用"):
        ff.create_order_form_field(
            seeded_db, order_type_code="HS", field_key="cond_on_inactive", label="条件字段",
            actor="admin",
            required_when={"field": "dep_inactive", "op": "eq", "values": ["其他"]},
        )


# ---------------------------------------------------------------- #19 作用域注册
def test_section_labels_rejects_unregistered_scope(seeded_db):
    """板块标题作用域必须先在注册表登记，否则写入前端永远读不到的僵尸配置。"""
    # "ZZ" 合法格式（2-10 位大写字母）但未在任何表单作用域注册。
    with pytest.raises(Validation, match="未按注册表登记"):
        ff.save_section_labels(
            seeded_db, order_type_code="ZZ", labels={"FINANCE": "资金"}, actor="admin",
        )


def test_section_labels_accepts_registered_scope(seeded_db):
    """已注册作用域（含非建单的订单操作作用域）仍可正常保存板块标题。"""
    saved = ff.save_section_labels(
        seeded_db, order_type_code="ORDEREDIT", labels={"FINANCE": "编辑页资金"}, actor="admin",
    )
    seeded_db.commit()
    assert saved == {"FINANCE": "编辑页资金"}
