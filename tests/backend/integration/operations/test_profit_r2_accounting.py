"""PROFIT-02 订单利润与 R2 报表归类口径。

口径（勿凭直觉改，详见 orders/amounts.py 顶部）：
- 只有收入大类、支出大类两个池子；售出价/返点是收入子类型，提号价/回收价/
  直接费用/分期坏账是支出子类型。子类型只作「其中项」展示，不加回净利。
- 作废（VOID）≠ 结算进度（OPEN/PARTIALLY_SETTLED/SETTLED）。结算进度登记即计入；
  VOID 是作废、不代表资金走向，收入侧一律排除，与售出价 CANCEL 冲销同规则。

验证范围：
- #3 旧模型 VOID 返点不再计订单利润收入（新模型作废走 reverse_cashflow 冲流水，
  结果一致）；
- #4 订单利润明细「其中返点」列排除 VOID；
- #2 R2 冲销经营收入生成的 OUT/BUSINESS_OUT 流水不得误记运营费用；
- #8 挂订单的运营费用流水只进订单支出大类（直接成本），不在 R2 运营费用重复计。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

from app.core.money import to_money
from app.domain.enums import (
    LinkStatus,
    RebateStatus,
    RebateType,
)
from app.domain.trade import Cashflow, RebateRecord
from app.finance.cashflows import create_cashflow, reverse_cashflow
from app.orders.create import create_order
from app.orders.amounts import order_amounts, order_profit_flow_by_order
from app.reporting.profit import order_profit_detail
from app.reporting.r2_monthly_pnl import r2_monthly_pnl

D = date(2026, 10, 17)


def _bare_order(seeded_db) -> int:
    order = create_order(
        seeded_db, order_type="TH", owner_id=1, trade_date=D, actor="pytest"
    )
    return order.id


def _add_rebate(seeded_db, order_id: int, amount: str, status: str) -> RebateRecord:
    rec = RebateRecord(
        rebate_no=f"REB-{uuid4().hex[:10]}",
        source_order_id=order_id,
        rebate_type=RebateType.SELL.value,
        amount=to_money(amount),
        collected_on=D,
        status=status,
        link_status=LinkStatus.LINKED.value,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(rec)
    seeded_db.flush()
    return rec


def _flow(seeded_db, *, direction, nature, amount, accounting_attribute=None,
          category="OTHER", order_id=None) -> Cashflow:
    flow = Cashflow(
        flow_no=f"CF-{uuid4().hex[:10]}",
        pool_id=1,
        occurred_on=D,
        nature=nature,
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


# --------------------------------------------------------------- #3 收入大类排除 VOID
def test_void_rebate_excluded_from_order_profit(seeded_db):
    """VOID 返点不是收入：结算进度三态计入、作废不加，与售出价冲销同规则。"""
    order_id = _bare_order(seeded_db)
    _add_rebate(seeded_db, order_id, "100", RebateStatus.SETTLED.value)
    _add_rebate(seeded_db, order_id, "50", RebateStatus.OPEN.value)
    _add_rebate(seeded_db, order_id, "300", RebateStatus.VOID.value)

    # 只有 SETTLED 100 + OPEN 50 计入收入大类；VOID 300 排除。
    rebate_income, _bad_debt = order_profit_flow_by_order(seeded_db, order_ids=[order_id])[order_id]
    assert rebate_income == Decimal("150.00")
    assert order_amounts(seeded_db, order_id)["PROFIT"] == Decimal("150.00")


def test_rebate_status_progress_still_counts(seeded_db):
    """守卫：PARTIALLY_SETTLED 属结算进度，登记即计入，不被 VOID 过滤误伤。"""
    order_id = _bare_order(seeded_db)
    _add_rebate(seeded_db, order_id, "80", RebateStatus.PARTIALLY_SETTLED.value)
    assert order_amounts(seeded_db, order_id)["PROFIT"] == Decimal("80.00")


# --------------------------------------------------------------- #4 其中返点列排除 VOID
def test_profit_detail_rebate_column_excludes_void(seeded_db):
    """「其中返点」列与收入大类同源：VOID 不进列，net_profit 同步。"""
    order_id = _bare_order(seeded_db)
    _add_rebate(seeded_db, order_id, "100", RebateStatus.SETTLED.value)
    _add_rebate(seeded_db, order_id, "300", RebateStatus.VOID.value)

    detail = order_profit_detail(seeded_db)
    item = next(row for row in detail["items"] if row["order_id"] == order_id)
    assert item["rebate"] == Decimal("100.00")
    assert item["income"] == Decimal("100.00")
    assert item["net_profit"] == Decimal("100.00")


# --------------------------------------------------------------- #2 R2 冲销经营收入不串列
def test_r2_reversal_of_business_income_not_counted_as_operating(seeded_db):
    """冲销经营收入生成 OUT/BUSINESS_OUT 的 REVERSAL 流水，不得凭空记成运营费用。

    原经营收入（IN/BUSINESS_IN 独立流水）+ 其冲销（反向 OUT，accounting=REVERSAL），
    两者都不属于 OPERATING_EXPENSE/OPERATING_COST 类；R2 运营费用应保持 0。
    """
    start = r2_monthly_pnl(seeded_db)
    before = next((r for r in start["items"] if r["month"] == "2026-10"), None)
    before_op = before["operating_expense"] if before else Decimal("0.00")

    income = create_cashflow(
        seeded_db, pool_id=1, occurred_on=D, direction="IN", nature="BUSINESS_IN",
        accounting_attribute="SELF_REVENUE",
        category="CUSTOMER_RECEIPT", amount=Decimal("800"), actor="pytest", note="经营收款",
    )
    reverse_cashflow(
        seeded_db, income.id, reversed_on=D, actor="pytest", reason="误收冲销",
    )

    after = r2_monthly_pnl(seeded_db)
    oct_item = next((r for r in after["items"] if r["month"] == "2026-10"), None)
    after_op = oct_item["operating_expense"] if oct_item else Decimal("0.00")
    assert after_op == before_op, (
        f"[BUG] 冲销经营收入后运营费用从 {before_op} 变成 {after_op}，凭空多记"
    )


# --------------------------------------------------------------- #8 R2 挂单运营费不双算
def test_r2_order_linked_operating_expense_not_double_counted(seeded_db):
    """挂订单的运营费用流水只进订单支出大类（R2 直接成本），不在运营费用重复计。"""
    order_id = _bare_order(seeded_db)
    start = r2_monthly_pnl(seeded_db)
    before = next((r for r in start["items"] if r["month"] == "2026-10"), None)
    before_cost = before["cost"] if before else Decimal("0.00")
    before_op = before["operating_expense"] if before else Decimal("0.00")

    _flow(
        seeded_db, direction="OUT", nature="BUSINESS_OUT", amount="300",
        accounting_attribute="OPERATING_EXPENSE", category="OPERATING_COST",
        order_id=order_id,
    )

    after = r2_monthly_pnl(seeded_db)
    oct_item = next(r for r in after["items"] if r["month"] == "2026-10")
    # 直接成本 +300（挂单支出归该单支出大类），运营费用不变（不重复计）。
    assert oct_item["cost"] == before_cost + Decimal("300.00")
    assert oct_item["operating_expense"] == before_op


# --------------------------------------------------------------- #8 独立运营费仍计运营费用（守卫）
def test_r2_standalone_operating_expense_still_counted(seeded_db):
    """守卫：不挂订单的独立运营费用仍进运营费用列（order_id is None 不过滤掉）。"""
    start = r2_monthly_pnl(seeded_db)
    before = next((r for r in start["items"] if r["month"] == "2026-10"), None)
    before_op = before["operating_expense"] if before else Decimal("0.00")

    _flow(
        seeded_db, direction="OUT", nature="BUSINESS_OUT", amount="250",
        accounting_attribute="OPERATING_EXPENSE", category="OPERATING_COST",
        order_id=None,
    )

    after = r2_monthly_pnl(seeded_db)
    oct_item = next(r for r in after["items"] if r["month"] == "2026-10")
    assert oct_item["operating_expense"] == before_op + Decimal("250.00")
