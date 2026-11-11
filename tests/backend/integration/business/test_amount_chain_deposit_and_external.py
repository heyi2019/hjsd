"""金额大类口径回归（批次三）：押金不是经营收支 + 外部流入单列。

口径锚点：利润=收入大类−支出大类；押金进出是「资金占用」（EXTERNAL/DEPOSIT），
既不是经营收入也不是经营支出，只有现金头寸才体现；外部流入（投资款/老板打款）
是独立资金来源，进现金余额但不进经营收入，必须单列才能「发生额列合计=余额变动」。

覆盖修复：
- #9 押金挂 source_order_id 不再混入 R2 订单直接成本。
- #10 资金池 income/expense 卡片剔除押金占用/释放；cash_balance/available 口径不动。
- #5 资金日报新增 external_in 列承接 EXTERNAL_IN。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

from app.core.money import to_money
from app.domain.enums import Nature
from app.domain.foundation import Pool
from app.domain.trade import Cashflow
from app.finance import service as finance_service
from app.orders import service as orders_service
from app.reporting import service as reporting_service
from sqlalchemy import select

TODAY = date(2026, 10, 17)


def _pool(seeded_db, code: str) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == code))
    assert pool is not None, f"种子池 {code} 缺失"
    return pool


def _flow(seeded_db, *, pool_id, direction, nature, amount, attribute=None, order_id=None):
    seeded_db.add(Cashflow(
        flow_no=f"CF-{uuid4().hex[:10]}",
        pool_id=pool_id, occurred_on=TODAY, nature=nature,
        fund_nature="EXTERNAL" if nature == Nature.EXTERNAL_IN.value else "BUSINESS",
        accounting_attribute=attribute, category="OTHER", direction=direction,
        amount=to_money(amount), status="APPROVED", order_id=order_id,
        created_by="pytest", updated_by="pytest",
    ))
    seeded_db.flush()


# --------------------------------------------------------------- #10 押金不进经营收支卡片
def test_deposit_excluded_from_pool_income_expense_but_cash_moves(seeded_db):
    """押金占用降低现金余额，但不虚增 expense；释放也不虚增 income。"""
    invest = _pool(seeded_db, "HJ_INVEST")
    before = orders_service.pool_balance(seeded_db, invest.id)
    deposit = finance_service.create_deposit(
        seeded_db, pool_id=invest.id, amount=Decimal("2000"), paid_on=TODAY, actor="pytest"
    )
    seeded_db.expire_all()
    after_hold = orders_service.pool_balance(seeded_db, invest.id)
    # 现金头寸含押金流出；押金占用字段 +2000；但经营支出不变。
    assert after_hold["cash_balance"] == before["cash_balance"] - Decimal("2000")
    assert after_hold["deposit_held"] == Decimal("2000.00")
    assert after_hold["available"] == after_hold["cash_balance"] - Decimal("2000")
    assert after_hold["expense"] == before["expense"], (
        f"[BUG] 押金占用计入经营支出: {before['expense']}->{after_hold['expense']}"
    )
    assert after_hold["income"] == before["income"]

    # 部分释放：现金回流，但经营收入不变。
    finance_service.return_deposit(
        seeded_db, deposit.id, amount=Decimal("1200"), released_on=TODAY, actor="pytest"
    )
    seeded_db.expire_all()
    after_release = orders_service.pool_balance(seeded_db, invest.id)
    assert after_release["cash_balance"] == after_hold["cash_balance"] + Decimal("1200")
    assert after_release["income"] == before["income"], (
        f"[BUG] 押金释放计入经营收入: {before['income']}->{after_release['income']}"
    )


# --------------------------------------------------------------- #9 押金不进 R2 订单成本
def test_deposit_linked_to_order_not_in_r2_direct_cost(seeded_db):
    """押金挂 source_order_id 后，R2 订单直接成本不因此虚增。"""
    # 用一个已存在的订单 id（种子或新建）；押金允许无来源订单，这里构造带来源。
    from app.orders import service as order_service
    order = order_service.create_order(
        seeded_db, order_type="TH", owner_id=1, trade_date=TODAY, actor="pytest"
    )
    invest = _pool(seeded_db, "HJ_INVEST")
    base = reporting_service.r2_monthly_pnl(seeded_db)
    oct_before = next((r for r in base["items"] if r["month"] == "2026-10"), None)
    before_cost = oct_before["account_direct_cost"] if oct_before else Decimal("0.00")

    finance_service.create_deposit(
        seeded_db, pool_id=invest.id, amount=Decimal("2000"), paid_on=TODAY,
        source_order_id=order.id, actor="pytest",
    )
    after = reporting_service.r2_monthly_pnl(seeded_db)
    oct_item = next((r for r in after["items"] if r["month"] == "2026-10"), None)
    after_cost = oct_item["account_direct_cost"] if oct_item else Decimal("0.00")
    assert after_cost == before_cost, (
        f"[BUG] 押金挂订单后计入 R2 直接成本: {before_cost}->{after_cost}"
    )


def test_order_linked_normal_expense_still_in_r2_direct_cost(seeded_db):
    """守卫：挂订单的普通经营支出（非押金）仍进 R2 直接成本（NULL 属性不被误删）。"""
    from app.orders import service as order_service
    order = order_service.create_order(
        seeded_db, order_type="TH", owner_id=1, trade_date=TODAY, actor="pytest"
    )
    invest = _pool(seeded_db, "HJ_INVEST")
    base = reporting_service.r2_monthly_pnl(seeded_db)
    oct_before = next((r for r in base["items"] if r["month"] == "2026-10"), None)
    before_cost = oct_before["account_direct_cost"] if oct_before else Decimal("0.00")

    # accounting_attribute=None 的挂单支出，验证 != DEPOSIT 的 NULL 放行
    _flow(seeded_db, pool_id=invest.id, direction="OUT", nature="BUSINESS_OUT",
          amount="300", attribute=None, order_id=order.id)
    after = reporting_service.r2_monthly_pnl(seeded_db)
    oct_item = next(r for r in after["items"] if r["month"] == "2026-10")
    assert oct_item["account_direct_cost"] == before_cost + Decimal("300.00")


# --------------------------------------------------------------- #5 外部流入单列
def test_external_in_has_own_column_and_balances_reconcile(seeded_db):
    """EXTERNAL_IN 进现金余额且进 external_in 列；各发生额列合计=余额变动。"""
    invest = _pool(seeded_db, "HJ_INVEST")
    _flow(seeded_db, pool_id=invest.id, direction="IN",
          nature=Nature.EXTERNAL_IN.value, amount="5000")

    report = reporting_service.daily_funds_report(seeded_db, on=TODAY)
    item = next(r for r in report["items"] if r["pool_code"] == invest.code)
    assert item["external_in"] == Decimal("5000.00")
    assert item["income"] == Decimal("0.00"), "外部流入不得混入经营收入"
    assert report["total"]["external_in"] == Decimal("5000.00")

    # 当日发生额列合计 = 现金余额变动（期初→当日余额）
    cols = item["income"] + item["external_in"] - item["expense"] + item["transfer_in"] - item["transfer_out"]
    movement = item["cash_balance"] - item["opening"]
    assert cols == movement, (
        f"[BUG] 发生额列合计({cols}) ≠ 余额变动({movement})，EXTERNAL_IN 未单列"
    )
