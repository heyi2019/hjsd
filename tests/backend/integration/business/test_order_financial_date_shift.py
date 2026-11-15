"""REVERSAL-01 冲销流水与订单日期变更的财务一致性。

口径锚点：资金走向只有收入/支出两个大类；冲销流水必须 direction/nature 自洽，
否则余额按方向变了、资金池收支卡片与资金日报发生额列按 (direction, nature)
取数却都不体现，账对不上。平移成交日期时，凡按各自日期归期的子类型
（事件/流水/分期坏账/旧模型返点/账号买号日）必须一起平移，否则跨期撕裂。

验证范围：
- #1 冲销 SELL 生成 OUT/BUSINESS_OUT（不再是矛盾的 OUT/BUSINESS_IN）；
  冲销 BUY 仍是 IN/BUSINESS_IN。
- #6 成交日期平移同步 InstallmentDisposition.occurred_on（坏账归期）。
- #7 成交日期平移同步旧模型 RebateRecord.collected_on（返点归期）。
- #18 平移同步 Account.buy_date（仅本单有已过账 BUY 事件时）。
- #14 平移触及已对账资金池期间时拒绝。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.core.errors import Validation
from app.core.money import to_money
from app.domain.enums import (
    CashflowStatus,
    Direction,
    InstallmentContractType,
    InstallmentDispositionAction,
    InstallmentStatus,
    LinkStatus,
    Nature,
    ReconciliationStatus,
    RebateStatus,
    RebateType,
)
from app.domain.foundation import Pool
from app.domain.trade import (
    Account,
    Cashflow,
    Installment,
    InstallmentDisposition,
    Order,
    OrderEvent,
    RebateRecord,
    Reconciliation,
)
from app.orders.create import create_order
from app.orders.events import post_event
from app.orders.mutations import update_order
from app.reporting.r2_monthly_pnl import r2_monthly_pnl
from app.stocks.profile import create_account

D1 = date(2026, 9, 10)
D2 = date(2026, 10, 10)


def _recovery_order(seeded_db, *, trade_date: date = D1) -> tuple[Order, Account]:
    account = create_account(
        seeded_db,
        game_account=f"shift-{uuid4().hex[:8]}",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    order = create_order(
        seeded_db, order_type="HS", owner_id=1, trade_date=trade_date,
        actor="pytest", account_id=account.id,
    )
    return order, account


def _posted_flow(seeded_db, *, occurred_on, direction, nature, pool_id=1, order_id=None,
                 accounting_attribute=None) -> Cashflow:
    flow = Cashflow(
        flow_no=f"CF-{uuid4().hex[:10]}",
        pool_id=pool_id,
        occurred_on=occurred_on,
        nature=nature,
        fund_nature="BUSINESS",
        accounting_attribute=accounting_attribute,
        category="OTHER",
        direction=direction,
        amount=to_money("100"),
        status=CashflowStatus.APPROVED.value,
        order_id=order_id,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(flow)
    seeded_db.flush()
    return flow


# --------------------------------------------------------------- #1 CANCEL nature 自洽
def test_cancel_sell_flow_is_out_business_out(seeded_db):
    """冲销 SELL：direction 反转为 OUT，nature 必须同步为 BUSINESS_OUT。"""
    order, _account = _recovery_order(seeded_db)
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=D1, actor="pytest", pool_id=1,
    )
    sell_event, sell_flow = post_event(
        seeded_db, order.id, event_type="SELL", amount=Decimal("200"),
        occurred_on=D1, actor="pytest", pool_id=1,
    )
    cancel_event, cancel_flow = post_event(
        seeded_db, order.id, event_type="CANCEL", amount=Decimal("200"),
        occurred_on=D1, actor="pytest", pool_id=1,
        offset_event_id=sell_event.id, reason="冲销售出",
    )
    assert cancel_flow.direction == Direction.OUT.value
    assert cancel_flow.nature == Nature.BUSINESS_OUT.value, (
        f"[BUG] 冲销 SELL 的流水 nature={cancel_flow.nature}，OUT 却标 BUSINESS_IN"
    )
    # 资金池收支卡片：OUT/BUSINESS_OUT 计入 expense，账与余额自洽。
    from app.orders.pools import pool_balances
    balances = pool_balances(seeded_db, [1])
    # 主 SELL(IN 200) + BUY(OUT 100) + CANCEL(OUT 200) → expense 应含 BUY 100 + CANCEL 200
    assert balances[1]["expense"] >= Decimal("300.00")


def test_cancel_buy_flow_stays_in_business_in(seeded_db):
    """守卫：冲销 BUY 生成 IN/BUSINESS_IN，修复不应影响它。"""
    order, _account = _recovery_order(seeded_db)
    buy_event, _buy_flow = post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=D1, actor="pytest", pool_id=1,
    )
    _ce, cancel_flow = post_event(
        seeded_db, order.id, event_type="CANCEL", amount=Decimal("100"),
        occurred_on=D1, actor="pytest", pool_id=1,
        offset_event_id=buy_event.id, reason="冲销买入",
    )
    assert cancel_flow.direction == Direction.IN.value
    assert cancel_flow.nature == Nature.BUSINESS_IN.value


# --------------------------------------------------------------- #6/#7/#18 平移归期同源
def test_shift_moves_bad_debt_rebate_and_buy_date(seeded_db):
    """改成交日期：事件/流水/坏账处置/旧模型返点/账号买号日同步平移。"""
    order, account = _recovery_order(seeded_db, trade_date=D1)
    buy_event, _ = post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("1000"),
        occurred_on=D1, actor="pytest", pool_id=1,
    )
    assert account.buy_date == D1

    # 旧模型返点：collected_on = D1（无 REBATE 事件）
    seeded_db.add(RebateRecord(
        rebate_no=f"REB-{uuid4().hex[:10]}", source_order_id=order.id,
        rebate_type=RebateType.SELL.value,
        amount=to_money("200"), collected_on=D1, status=RebateStatus.SETTLED.value,
        link_status=LinkStatus.LINKED.value, created_by="pytest", updated_by="pytest",
    ))
    # 分期坏账：回收处置日 = D1
    inst = Installment(
        inst_no=f"INST-{uuid4().hex[:10]}", order_id=order.id,
        contract_type=InstallmentContractType.STOCK_SALE.value,
        principal=to_money("1000"), down_payment=to_money("0"), service_fee=to_money("0"),
        periods=1, per_period_service_fee=to_money("0"), per_period=to_money("1000"),
        paid_amount=to_money("0"), waived_amount=to_money("0"), bad_debt_amount=to_money("300"),
        first_due_on=D1, status=InstallmentStatus.DEFAULTED.value,
        created_by="pytest", updated_by="pytest",
    )
    seeded_db.add(inst)
    seeded_db.flush()
    seeded_db.add(InstallmentDisposition(
        installment_id=inst.id, account_id=account.id,
        action=InstallmentDispositionAction.RECOVER.value, occurred_on=D1,
        note="pytest 坏账", created_by="pytest", updated_by="pytest",
    ))
    seeded_db.flush()

    # 改成交日期 +30 天
    update_order(seeded_db, order.id, actor="pytest", trade_date=D2)
    seeded_db.expire_all()

    assert seeded_db.get(OrderEvent, buy_event.id).occurred_on == D2
    assert seeded_db.get(Account, account.id).buy_date == D2
    rebate = seeded_db.scalar(select(RebateRecord).where(RebateRecord.source_order_id == order.id))
    assert rebate.collected_on == D2
    disp = seeded_db.scalar(
        select(InstallmentDisposition).where(InstallmentDisposition.installment_id == inst.id)
    )
    assert disp.occurred_on == D2

    # 报表归月随之迁移：9 月归零，10 月含返点收入 200 + 坏账支出 300
    oct_item = next(r for r in r2_monthly_pnl(seeded_db)["items"] if r["month"] == "2026-10")
    assert oct_item["rebate_income"] == Decimal("200.00")
    assert oct_item["account_direct_cost"] >= Decimal("300.00")


# --------------------------------------------------------------- #14 对账边界
def test_shift_rejected_when_crossing_reconciled_period(seeded_db):
    """平移流水跨越资金池已对账日期时拒绝，保护已固化余额快照。"""
    order, _account = _recovery_order(seeded_db, trade_date=D1)
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=D1, actor="pytest", pool_id=1,
    )
    # 在流水旧日与新日之间建立对账快照（10-01）
    mid = date(2026, 10, 1)
    pool = seeded_db.scalar(select(Pool).where(Pool.id == 1))
    seeded_db.add(Reconciliation(
        pool_id=pool.id, reconciled_on=mid, account_label="test-account",
        system_balance=to_money("0"), statement_balance=to_money("0"), difference=to_money("0"),
        status=ReconciliationStatus.OPEN.value, unmatched_flow_ids=[],
        created_by="pytest", updated_by="pytest",
    ))
    seeded_db.flush()

    with pytest.raises(Validation, match="已对账期间"):
        update_order(seeded_db, order.id, actor="pytest", trade_date=D2)
