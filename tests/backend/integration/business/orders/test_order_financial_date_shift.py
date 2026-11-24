"""REVERSAL-01 冲销流水与订单日期变更的财务一致性。

口径锚点：资金走向只有收入/支出两个大类；冲销流水必须 direction/nature 自洽，
否则余额按方向变了、资金账户收支卡片与资金日报发生额列按 (direction)
取数却都不体现，账对不上。平移成交日期时，凡按各自日期归期的子类型
（事件/流水/分期坏账/旧模型返点/账号买号日）必须一起平移，否则跨期撕裂。

验证范围：
- #1 冲销 SELL 生成 OUT（方向反转自洽）；
  冲销 BUY 仍是 IN。
- #6 成交日期平移同步 InstallmentDisposition.occurred_on（坏账归期）。
- #7 成交日期平移同步旧模型 RebateRecord.collected_on（返点归期）。
- #18 平移同步 Account.buy_date（仅本单有已过账 BUY 事件时）。
- 平移触及已对账期间时保留原始对账快照。
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.core.money import to_money
from app.domain.enums import (
    Direction,
    InstallmentContractType,
    InstallmentDispositionAction,
    InstallmentStatus,
    RebateType,
)
from app.domain.trade import (
    Account,
    BalanceSnapshot,
    Cashflow,
    Deposit,
    Installment,
    InstallmentDisposition,
    Order,
    OrderEvent,
    RebateRecord,
)
from app.business.orders.create import create_order
from app.business.orders.events import post_event
from app.business.orders.mutations import update_order
from app.operations.reports.monthly_pnl import monthly_pnl_report
from app.business.inventory.profile import create_account
from app.finance.deposits.lifecycle import lose_deposit, return_deposit
from app.finance.deposits.writes import create_deposit
from app.finance.reconciliation.service import create_reconciliation
from app.finance.rebates import create_rebate

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


def _posted_flow(seeded_db, *, occurred_on, direction, pool_id=1, order_id=None,
                 accounting_attribute=None) -> Cashflow:
    flow = Cashflow(
        flow_no=f"CF-{uuid4().hex[:10]}",
        pool_id=pool_id,
        occurred_on=occurred_on,
        accounting_attribute=accounting_attribute,
        category="OTHER",
        direction=direction,
        amount=to_money("100"),
        order_id=order_id,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(flow)
    seeded_db.flush()
    return flow


# --------------------------------------------------------------- #1 CANCEL 方向自洽
def test_cancel_sell_flow_is_out(seeded_db):
    """冲销 SELL：direction 反转为 OUT。"""
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
    # 资金账户收支卡片：OUT 计入 expense，账与余额自洽。
    from app.finance.balances import pool_balances
    balances = pool_balances(seeded_db, [1])
    # 主 SELL(IN 200) + BUY(OUT 100) + CANCEL(OUT 200) → expense 应含 BUY 100 + CANCEL 200
    assert balances[1]["expense"] >= Decimal("300.00")


def test_cancel_buy_flow_stays_in(seeded_db):
    """守卫：冲销 BUY 生成 IN，修复不应影响它。"""
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
        amount=to_money("200"), collected_on=D1,
        created_by="pytest", updated_by="pytest",
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
    oct_item = next(r for r in monthly_pnl_report(seeded_db)["items"] if r["month"] == "2026-10")
    assert oct_item["rebate_income"] == Decimal("200.00")
    assert oct_item["cost"] >= Decimal("300.00")


def test_shift_crosses_reconciled_period_without_rewriting_snapshot(seeded_db):
    """允许平移已对账期间的流水，保留创建时的对账与首次快照。"""
    order, _account = _recovery_order(seeded_db, trade_date=D1)
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("100"),
        occurred_on=D1, actor="pytest", pool_id=1,
    )
    mid = date(2026, 10, 1)
    recon = create_reconciliation(seeded_db, pool_id=1, reconciled_on=mid,
                                  account_label="test-account", statement_balance="0",
                                  reason="核对", actor="pytest")
    snapshot = seeded_db.scalar(select(BalanceSnapshot).where(BalanceSnapshot.reconciliation_id == recon.id))
    assert snapshot.balance == recon.system_balance == Decimal("-100.00")

    update_order(seeded_db, order.id, actor="pytest", trade_date=D2)
    assert recon.system_balance == snapshot.balance == Decimal("-100.00")
    flow = seeded_db.scalar(select(Cashflow).where(Cashflow.order_id == order.id))
    assert flow.occurred_on == D2


def test_shift_updates_linked_deposit_dates_and_each_cashflow(seeded_db):
    order, _account = _recovery_order(seeded_db, trade_date=D1)
    deposit = create_deposit(seeded_db, pool_id=1, amount="100", paid_on=D1,
                             expected_release_on=D1 + timedelta(days=40),
                             source_order_id=order.id, actor="pytest")
    return_deposit(seeded_db, deposit.id, amount="20", released_on=D1 + timedelta(days=2), actor="pytest")
    lose_deposit(seeded_db, deposit.id, amount="30", lost_on=D1 + timedelta(days=3),
                 category="OTHER", reason="损失", actor="pytest")
    unaffected = create_deposit(seeded_db, pool_id=1, amount="50", paid_on=D1, actor="pytest")

    update_order(seeded_db, order.id, actor="pytest", trade_date=D2)

    assert deposit.paid_on == D2
    assert deposit.expected_release_on == D2 + timedelta(days=40)
    assert deposit.released_on == D2 + timedelta(days=2)
    assert deposit.lost_on == D2 + timedelta(days=3)
    flows = seeded_db.scalars(select(Cashflow).where(Cashflow.source_type == "DEPOSIT", Cashflow.source_id == str(deposit.id))).all()
    assert {flow.occurred_on for flow in flows} == {D2, D2 + timedelta(days=2), D2 + timedelta(days=3)}
    assert seeded_db.get(Deposit, unaffected.id).paid_on == D1


@pytest.mark.parametrize("override_event", [False, True])
def test_execution_detail_order_date_edit_shifts_related_financial_dates(seeded_client, seeded_db, headers, override_event):
    order, _account = _recovery_order(seeded_db, trade_date=D1)
    event, _ = post_event(seeded_db, order.id, event_type="BUY", amount="100", occurred_on=D1,
                          actor="pytest", pool_id=1)
    rebate = create_rebate(seeded_db, source_order_id=order.id, rebate_type="BUY", amount="10",
                           collected_on=D1 + timedelta(days=1), actor="pytest")
    deposit = create_deposit(seeded_db, pool_id=1, amount="30", paid_on=D1 + timedelta(days=2),
                             expected_release_on=D1 + timedelta(days=12), source_order_id=order.id,
                             actor="pytest")
    order_id, event_id, rebate_id, deposit_id = order.id, event.id, rebate.id, deposit.id
    seeded_db.commit()

    events = [{"id": event_id, "expected_amount": "100", "amount": "100", "occurred_at": "2026-10-15T12:00:00"}] if override_event else []
    response = seeded_client.patch(f"/api/orders/{order_id}/execution-edit", headers=headers, json={
        "events": events, "orders": [{"order_id": order_id, "occurred_at": "2026-10-10T12:30:00"}],
    })
    assert response.status_code == 200, response.text
    seeded_db.expire_all()
    assert seeded_db.get(Order, order_id).trade_date == D2
    expected_event_date = D2 + timedelta(days=5) if override_event else D2
    assert seeded_db.get(OrderEvent, event_id).occurred_on == expected_event_date
    assert seeded_db.get(RebateRecord, rebate_id).collected_on == D2 + timedelta(days=1)
    assert seeded_db.get(Deposit, deposit_id).paid_on == D2 + timedelta(days=2)
    assert seeded_db.get(Deposit, deposit_id).expected_release_on == D2 + timedelta(days=12)
    flows = seeded_db.scalars(select(Cashflow).where(Cashflow.order_id == order_id)).all()
    assert {flow.occurred_on for flow in flows} == {expected_event_date, D2 + timedelta(days=1), D2 + timedelta(days=2)}
    detail_response = seeded_client.get(f"/api/orders/{order_id}/execution-detail", headers=headers)
    assert detail_response.status_code == 200, detail_response.text
    detail = detail_response.json()
    detail_order = next(item for item in detail["orders"] if item["order_id"] == order_id)
    assert detail_order["occurred_at"].startswith(D2.isoformat())
    event_view = next(item for item in detail_order["events"] if item["id"] == event_id)
    assert event_view["occurred_at"].startswith(expected_event_date.isoformat())
    date_by_flow = {flow.flow_no: flow.occurred_on.isoformat() for flow in flows}
    for row in detail["detail_view"]["finance_rows"]:
        if row["flow_no"] in date_by_flow:
            assert row["occurred_at"].startswith(date_by_flow[row["flow_no"]])


def test_order_date_shift_updates_consignment_time_visible_in_detail(seeded_client, seeded_db, headers):
    order, _account = _recovery_order(seeded_db, trade_date=D1)
    event, _ = post_event(
        seeded_db, order.id, event_type="OPERATE", operation_type="CONSIGNMENT", amount=0,
        occurred_on=D1 + timedelta(days=3), actor="pytest",
        form_extra={"consignment_platforms": ["测试平台"], "listed_at": "2026-09-13T13:45:00"},
    )
    order_id, event_id = order.id, event.id
    seeded_db.commit()
    update_order(seeded_db, order_id, actor="pytest", trade_date=D2)
    seeded_db.commit()

    seeded_db.expire_all()
    assert seeded_db.get(OrderEvent, event_id).form_extra["listed_at"] == "2026-10-13T13:45:00"
    response = seeded_client.get(f"/api/orders/{order_id}/execution-detail", headers=headers)
    assert response.status_code == 200, response.text
    detail = response.json()
    detail_event = next(item for item in detail["orders"][0]["events"] if item["id"] == event_id)
    assert detail_event["occurred_at"] == "2026-10-13T13:45:00"
    operation = next(item for item in detail["detail_view"]["operation_rows"] if item["key"] == "consignment")
    assert operation["occurred_at"] == "2026-10-13T13:45:00"
