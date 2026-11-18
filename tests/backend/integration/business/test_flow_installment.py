"""FLOW-01 tests/backend/test_flow_installment：跨模块流程 D —— 分期与回款（BIZ-FLOW-INSTALLMENT）。

业务链路（项目跨模块测试·流程 D）
-------------------------------
HS 回收单 → BUY（入库）→ 建分期合约(STOCK_SALE) → 两期回款(PAYMENT) → 交付(DELIVER)
→ 分期状态机 PENDING→ACTIVE→SETTLED→DELIVERED，订单最终 COMPLETED，回款现金流
落入同一资金账户。另验 DG/代挂不允许分期（仅全款）。

本文件只验证**跨模块数据一致性**，不重复单模块规则断言。
测试分类：服务级集成（seeded_db 校验 DB 状态）。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
import pytest
from sqlalchemy import select

from app.core.errors import Validation
from app.domain.enums import Direction, InstallmentStatus, OrderStatus
from app.domain.foundation import Pool
from app.domain.trade import Account, Order
from app.domain.trade_models.cashflow import Cashflow
from app.orders import events
from app.orders.create import create_order
from app.installments.create import create_installment
from app.installments.recovery import deliver
from app.installments.repayments.pay import pay

TODAY = date(2026, 10, 7)


def _first_active_pool(session) -> Pool:
    return session.scalars(select(Pool).where(Pool.status == "ACTIVE")).first()


def test_flow_d_installment_full_lifecycle(seeded_db):
    """BIZ-FLOW-INSTALLMENT-001：分期全链路，状态机 + 资金同源一致。"""
    order = create_order(
        seeded_db, order_type="HS", trade_date=TODAY, actor="pytest",
        account_snapshot={"game_account": "flow-d-001", "game_type": "王者荣耀"},
    )
    pool = _first_active_pool(seeded_db)

    events.post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("1000"),
        occurred_on=TODAY, actor="pytest", pool_id=pool.id,
    )
    account = seeded_db.get(Account, order.account_id)
    assert account.status == "WAITING"

    # 建分期合约（STOCK_SALE，HS 允许）：起点 PENDING，订单进入 INSTALLMENT，账号 SOLD。
    inst = create_installment(
        seeded_db, order_id=order.id, contract_type="STOCK_SALE",
        principal=Decimal("1000"), periods=2, per_period=Decimal("600"),
        down_payment=Decimal("0"), first_due_on=TODAY, actor="pytest",
    )
    assert inst.status == InstallmentStatus.PENDING.value
    order = seeded_db.get(Order, order.id)
    assert order.status == OrderStatus.INSTALLMENT.value
    account = seeded_db.get(Account, order.account_id)
    assert account.status == "SOLD"

    inst, _ = pay(
        seeded_db, inst.id, amount=Decimal("600"), paid_on=TODAY,
        actor="pytest", pool_id=pool.id,
    )
    assert inst.status == InstallmentStatus.ACTIVE.value

    inst, _ = pay(
        seeded_db, inst.id, amount=Decimal("600"), paid_on=TODAY,
        actor="pytest", pool_id=pool.id,
    )
    assert inst.status == InstallmentStatus.SETTLED.value

    inst = deliver(
        seeded_db, inst.id,
        delivered_on=TODAY, note="换绑交付凭证", actor="pytest",
    )
    assert inst.status == InstallmentStatus.DELIVERED.value
    order = seeded_db.get(Order, order.id)
    assert order.status == OrderStatus.COMPLETED.value

    # 两笔 PAYMENT 现金流入同一资金账户，合计 1200。
    flows = seeded_db.scalars(
        select(Cashflow).where(Cashflow.order_id == order.id)
    ).all()
    payment_flows = [f for f in flows if f.direction == Direction.IN.value]
    assert len(payment_flows) == 2
    assert all(f.pool_id == pool.id for f in payment_flows)
    assert sum(f.amount for f in payment_flows) == Decimal("1200.00")


def test_flow_d_dg_not_allowed_installment(seeded_db):
    """BIZ-FLOW-INSTALLMENT-002：DG/代挂不允许分期（仅全款），建合约即拒。"""
    dg = create_order(
        seeded_db, order_type="DG", trade_date=TODAY, actor="pytest",
        account_snapshot={"game_account": "flow-d-dg-001", "game_type": "王者荣耀"},
    )
    with pytest.raises(Validation):
        create_installment(
            seeded_db, order_id=dg.id, contract_type="STOCK_SALE",
            principal=Decimal("1000"), periods=2, per_period=Decimal("600"),
            down_payment=Decimal("0"), first_due_on=TODAY, actor="pytest",
        )
