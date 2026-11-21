"""FLOW-01 tests/backend/test_flow_distribution：跨模块流程 C —— 分销资金结算（TH 提号 / DG 代挂）。

业务链路（项目跨模块测试·流程 C）
-------------------------------
TH（提号）/ DG（代挂）订单同属分销 business_mode，但其资金结算口径与自营 HS 不同：
- 核算属性区分回收(SELF_*)与提号/代挂(TH_*/DG_*)；
- BUY/SELL 落入同一默认业务池，同一池余额 = 收入 − 支出；
- DG 不允许 BUY（仅全款），且其 SELL 未配置默认 PRINCIPAL 资金账户路由，必须显式 pool_id。

本文件只验证**跨模块资金结算一致性**，不重复单模块规则断言。
测试分类：服务级集成（seeded_db 校验 DB 状态）。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
import pytest
from sqlalchemy import select

from app.core.errors import Validation
from app.domain.enums import AccountingAttribute, Direction
from app.domain.foundation import Pool
from app.domain.trade import Account, Order
from app.domain.trade_models.cashflow import Cashflow
from app.business import events
from app.business.orders.create import create_order
from app.business.inventory.profile import create_account

TODAY = date(2026, 10, 6)


def _first_active_pool(session) -> Pool:
    return session.scalars(select(Pool).where(Pool.status == "ACTIVE")).first()


def test_flow_c_th_distribution_fund_settlement(seeded_db):
    """BIZ-FLOW-DIST-001：TH 分销（提号）BUY+SELL 资金结算与核算属性区分。"""
    account = create_account(
        seeded_db,
        game_account="flow-c-th-001",
        business_mode="DISTRIBUTION",
        inventory_type="PICKUP",
        actor="pytest",
    )
    order = create_order(
        seeded_db, order_type="TH", trade_date=TODAY, actor="pytest", account_id=account.id,
    )

    _buy_evt, buy_flow = events.post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("800"),
        occurred_on=TODAY, actor="pytest",
    )
    _sell_evt, sell_flow = events.post_event(
        seeded_db, order.id, event_type="SELL", amount=Decimal("2000"),
        occurred_on=TODAY, actor="pytest",
    )

    # 分销核算属性与自营 HS 区分开（TH_DIRECT_COST / TH_REVENUE，而非 SELF_*）。
    assert buy_flow.accounting_attribute == AccountingAttribute.TH_DIRECT_COST.value
    assert sell_flow.accounting_attribute == AccountingAttribute.TH_REVENUE.value
    assert buy_flow.direction == Direction.OUT.value
    assert sell_flow.direction == Direction.IN.value

    # 分销资金账户路由：BUY 与 SELL 落入同一默认业务池。
    assert buy_flow.pool_id == sell_flow.pool_id

    rows = seeded_db.scalars(
        select(Cashflow).where(Cashflow.order_id == order.id)
    ).all()
    signed = sum(
        (f.amount if f.direction == Direction.IN.value else -f.amount) for f in rows
    )
    assert signed == Decimal("1200.00")  # 2000 - 800

    assert seeded_db.get(Order, order.id).status == "COMPLETED"


def test_flow_c_dg_consignment_sell_and_buy_rejected(seeded_db):
    """BIZ-FLOW-DIST-002：DG 代挂仅全款——拒 BUY；SELLE 必须显式 pool_id。"""
    dg = create_order(
        seeded_db, order_type="DG", trade_date=TODAY, actor="pytest",
        account_snapshot={"game_account": "flow-c-dg-001", "game_type": "王者荣耀"},
    )
    assert dg.account_id is not None
    account = seeded_db.get(Account, dg.account_id)
    assert account.business_mode == "DISTRIBUTION"
    assert account.inventory_type == "CONSIGNMENT"
    assert account.status == "WAITING"

    pool = _first_active_pool(seeded_db)

    # DG 不允许 BUY（代挂仅全款）。
    with pytest.raises(Validation):
        events.post_event(
            seeded_db, dg.id, event_type="BUY", amount=Decimal("500"),
            occurred_on=TODAY, actor="pytest", pool_id=pool.id,
        )

    # DG SELL 核算属性为 DG_REVENUE（2026-11-18 口径改版，原 SERVICE_REVENUE）；必须显式 pool_id（无默认 PRINCIPAL 路由）。
    _sell_evt, sell_flow = events.post_event(
        seeded_db, dg.id, event_type="SELL", amount=Decimal("900"),
        occurred_on=TODAY, actor="pytest", pool_id=pool.id,
    )
    assert sell_flow.accounting_attribute == AccountingAttribute.DG_REVENUE.value
    assert sell_flow.direction == Direction.IN.value
    assert sell_flow.pool_id == pool.id

    account = seeded_db.get(Account, dg.account_id)
    assert account.status == "SOLD"  # WAITING --SELL--> SOLD
    order = seeded_db.get(Order, dg.id)
    assert order.status == "COMPLETED"
