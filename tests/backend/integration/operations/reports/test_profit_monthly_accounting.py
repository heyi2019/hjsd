"""PROFIT-02 订单利润与 月度损益 报表归类口径。

口径（勿凭直觉改，详见 orders/amounts.py 顶部）：
- 只有收入大类、支出大类两个池子；售出价/返点是收入子类型，提号价/回收价/
  直接费用/分期坏账是支出子类型。子类型只作「其中项」展示，不加回净利。
- 返点登记即收入确认；作废走 reverse_cashflow 冲销流水自动减收入。

验证范围：
- #2 月度损益 冲销经营收入生成的 OUT 流水不得误记运营费用；
- #8 挂订单的运营费用流水只进订单支出大类（直接成本），不在 月度损益 运营费用重复计。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

from sqlalchemy import event

from app.core.money import to_money
from app.domain.enums import (
    RebateType,
)
from app.domain.trade import Cashflow, RebateRecord
from app.finance.cashflow.cashflows import create_cashflow, reverse_cashflow
from app.business.orders.create import create_order
from app.operations.reports.monthly_pnl import monthly_pnl_report

D = date(2026, 10, 17)


def _bare_order(seeded_db) -> int:
    order = create_order(
        seeded_db, order_type="TH", owner_id=1, trade_date=D, actor="pytest"
    )
    return order.id


def _add_rebate(seeded_db, order_id: int, amount: str) -> RebateRecord:
    rec = RebateRecord(
        rebate_no=f"REB-{uuid4().hex[:10]}",
        source_order_id=order_id,
        rebate_type=RebateType.SELL.value,
        amount=to_money(amount),
        collected_on=D,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(rec)
    seeded_db.flush()
    return rec


def _flow(seeded_db, *, direction, amount, accounting_attribute=None,
          category="OTHER", order_id=None) -> Cashflow:
    flow = Cashflow(
        flow_no=f"CF-{uuid4().hex[:10]}",
        pool_id=1,
        occurred_on=D,
        accounting_attribute=accounting_attribute,
        category=category,
        direction=direction,
        amount=to_money(amount),
        order_id=order_id,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(flow)
    seeded_db.flush()
    return flow


# --------------------------------------------------------------- #2 月度损益 冲销经营收入不串列
def test_monthly_reversal_of_business_income_not_counted_as_operating(seeded_db):
    """冲销经营收入生成 OUT 的 REVERSAL 流水，不得凭空记成运营费用。

    原经营收入（IN 独立流水）+ 其冲销（反向 OUT，accounting=REVERSAL），
    两者都不属于 OPERATING_EXPENSE/OPERATING_COST 类；月度损益 运营费用应保持 0。
    """
    start = monthly_pnl_report(seeded_db)
    before = next((r for r in start["items"] if r["month"] == "2026-10"), None)
    before_op = before["operating_expense"] if before else Decimal("0.00")

    income = create_cashflow(
        seeded_db, pool_id=1, occurred_on=D, direction="IN", accounting_attribute="SELF_REVENUE",
        category="CUSTOMER_RECEIPT", amount=Decimal("800"), actor="pytest", note="经营收款",
    )
    reverse_cashflow(
        seeded_db, income.id, reversed_on=D, actor="pytest", reason="误收冲销",
    )

    after = monthly_pnl_report(seeded_db)
    oct_item = next((r for r in after["items"] if r["month"] == "2026-10"), None)
    after_op = oct_item["operating_expense"] if oct_item else Decimal("0.00")
    assert after_op == before_op, (
        f"[BUG] 冲销经营收入后运营费用从 {before_op} 变成 {after_op}，凭空多记"
    )


# --------------------------------------------------------------- #8 月度损益 挂单运营费不双算
def test_monthly_order_linked_operating_expense_not_double_counted(seeded_db):
    """挂订单的运营费用流水只进订单支出大类（月度损益 直接成本），不在运营费用重复计。"""
    order_id = _bare_order(seeded_db)
    start = monthly_pnl_report(seeded_db)
    before = next((r for r in start["items"] if r["month"] == "2026-10"), None)
    before_cost = before["cost"] if before else Decimal("0.00")
    before_op = before["operating_expense"] if before else Decimal("0.00")

    _flow(
        seeded_db, direction="OUT", amount="300",
        accounting_attribute="OPERATING_EXPENSE", category="OPERATING_COST",
        order_id=order_id,
    )

    after = monthly_pnl_report(seeded_db)
    oct_item = next(r for r in after["items"] if r["month"] == "2026-10")
    # 直接成本 +300（挂单支出归该单支出大类），运营费用不变（不重复计）。
    assert oct_item["cost"] == before_cost + Decimal("300.00")
    assert oct_item["operating_expense"] == before_op


# --------------------------------------------------------------- #8 独立运营费仍计运营费用（守卫）
def test_monthly_standalone_operating_expense_still_counted(seeded_db):
    """守卫：不挂订单的独立运营费用仍进运营费用列（order_id is None 不过滤掉）。"""
    start = monthly_pnl_report(seeded_db)
    before = next((r for r in start["items"] if r["month"] == "2026-10"), None)
    before_op = before["operating_expense"] if before else Decimal("0.00")

    _flow(
        seeded_db, direction="OUT", amount="250",
        accounting_attribute="OPERATING_EXPENSE", category="OPERATING_COST",
        order_id=None,
    )

    after = monthly_pnl_report(seeded_db)
    oct_item = next(r for r in after["items"] if r["month"] == "2026-10")
    assert oct_item["operating_expense"] == before_op + Decimal("250.00")


def test_monthly_loads_only_period_flows_and_cross_period_reversal_original(seeded_db):
    """短周期报表不加载无关历史流水，但须查到区间外的冲销原流水。"""
    original = create_cashflow(
        seeded_db, pool_id=1, occurred_on=date(2026, 9, 20), direction="OUT",
        accounting_attribute="OPERATING_EXPENSE", category="OFFICE",
        amount=Decimal("80"), actor="pytest",
    )
    reversal = reverse_cashflow(
        seeded_db, original.id, reversed_on=D, actor="pytest", reason="跨期冲销",
    )
    current = create_cashflow(
        seeded_db, pool_id=1, occurred_on=D, direction="OUT",
        accounting_attribute="OPERATING_EXPENSE", category="OFFICE",
        amount=Decimal("30"), actor="pytest",
    )
    outside = [
        create_cashflow(
            seeded_db, pool_id=1, occurred_on=day, direction="OUT",
            accounting_attribute="OPERATING_EXPENSE", category="OFFICE",
            amount=Decimal("10"), actor="pytest",
        )
        for day in (date(2026, 9, 1), date(2026, 11, 1))
    ]
    expected_loaded = {original.flow_no, reversal.flow_no, current.flow_no}
    outside_nos = {flow.flow_no for flow in outside}
    seeded_db.flush()
    seeded_db.expunge_all()
    loaded_flow_nos = set()

    def record_load(_session, instance):
        if isinstance(instance, Cashflow):
            loaded_flow_nos.add(instance.flow_no)

    event.listen(seeded_db, "loaded_as_persistent", record_load)
    try:
        report = monthly_pnl_report(
            seeded_db, from_date=date(2026, 10, 1), to_date=date(2026, 10, 31),
        )
    finally:
        event.remove(seeded_db, "loaded_as_persistent", record_load)

    assert report["total"]["operating_expense"] == Decimal("-50.00")
    assert expected_loaded <= loaded_flow_nos
    assert not (outside_nos & loaded_flow_nos)
