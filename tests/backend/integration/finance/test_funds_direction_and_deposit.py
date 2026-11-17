"""DEPOSIT-01 资金中心收支方向与押金业务口径（2026-11-12 用户裁决）。

口径锚点：利润=收入大类−支出大类；资金中心每个资金账户的所有资金流动只按
收入(IN)/支出(OUT)两个方向呈现，业务名词都是大类下的「子类型 / 其中项」：
- 收入大类：售出价(SELL)、返点(REBATE)、外部注入(EXTERNAL_IN)、押金释放、其他流入；
- 支出大类：回收价/提号价(BUY)、押金占用、直接费用、分期坏账、其他流出。
子类型不单列、不另立大类；资金中心只按 (direction, nature) 分箱进 income/expense。

验证范围（2026-11-12 资金中心两方向 + 押金完整走业务口径 C）：
- #10 押金占用进 expense、释放/取消进 income（原为从经营收支卡片剔除）；
     cash_balance=income−expense；available=cash_balance（押金占用已在 expense 扣过，
     不再二次减 deposit_held；deposit_held 降为其中项信息列，2026-11-12 裁决）。
- #5  外部注入并入 income、删除 external_in 独立列（原为单列）。
- #9（已由 C 推翻）：押金挂单改为完整进业务口径——占用进 R2 直接成本、
     释放进收入；押金线只有一套逻辑：净额=收入−支出，正为利润、负为损失
     （损失=−利润），不另记第二次现金流。
- 押金损失不重复：business_cashflow_filter 只排除损失那笔 OUT，资金中心/
     订单利润/报表同源(R3/R5)/R2 月度损益共用同一谓词。
- 售出/返点是收入子类型、回收/提号是支出子类型，均进大类不单列。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

from app.core.money import to_money
from app.domain.enums import CashflowSourceType, Nature
from app.domain.foundation import Pool
from app.domain.trade import Cashflow
from app.finance.deposits import create_deposit, lose_deposit, return_deposit
from app.finance.balances import pool_balance
from app.reporting.r2_monthly_pnl import r2_monthly_pnl
from sqlalchemy import select

TODAY = date(2026, 10, 17)


def _pool(seeded_db, code: str) -> Pool:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == code))
    assert pool is not None, f"种子池 {code} 缺失"
    return pool


def _flow(
    seeded_db, *, pool_id, direction, nature, amount,
    attribute=None, order_id=None, category="OTHER", source_type="MANUAL", source_id=None,
):
    seeded_db.add(Cashflow(
        flow_no=f"CF-{uuid4().hex[:10]}",
        pool_id=pool_id, occurred_on=TODAY, nature=nature,
        accounting_attribute=attribute, category=category, direction=direction,
        amount=to_money(amount), order_id=order_id,
        source_type=source_type,
        source_id=source_id,
        created_by="pytest", updated_by="pytest",
    ))
    seeded_db.flush()


# ------------------------------- #10 押金占用进支出 / 释放进收入（资金中心呈现层）
def test_deposit_hold_in_expense_release_in_income(seeded_db):
    """押金占用=支出、释放=收入；现金头寸 / 押金占用 / 可用余额口径不变。"""
    invest = _pool(seeded_db, "HJ_INVEST")
    before = pool_balance(seeded_db, invest.id)
    deposit = create_deposit(
        seeded_db, pool_id=invest.id, amount=Decimal("2000"), paid_on=TODAY, actor="pytest"
    )
    seeded_db.expire_all()
    after_hold = pool_balance(seeded_db, invest.id)
    # 现金头寸含押金流出；押金占用 +2000；押金占用进资金中心支出。
    assert after_hold["cash_balance"] == before["cash_balance"] - Decimal("2000")
    assert after_hold["deposit_held"] == Decimal("2000.00")
    # 支出口径：押金占用已在 expense/cash_balance 扣过一次，available 不再二次扣 held
    assert after_hold["available"] == after_hold["cash_balance"]
    assert after_hold["expense"] == before["expense"] + Decimal("2000"), (
        f"[BUG] 押金占用未计入资金中心支出: {before['expense']}->{after_hold['expense']}"
    )
    assert after_hold["income"] == before["income"]

    # 部分释放：现金回流 +1200，押金释放进资金中心收入。
    return_deposit(
        seeded_db, deposit.id, amount=Decimal("1200"), released_on=TODAY, actor="pytest"
    )
    seeded_db.expire_all()
    after_release = pool_balance(seeded_db, invest.id)
    assert after_release["cash_balance"] == after_hold["cash_balance"] + Decimal("1200")
    assert after_release["income"] == before["income"] + Decimal("1200"), (
        f"[BUG] 押金释放未计入资金中心收入: {before['income']}->{after_release['income']}"
    )


# -------------- C 押金完整走业务口径：R2 与订单利润逐笔同源（推翻旧 #9）
def test_deposit_linked_to_order_in_r2_direct_cost_same_source_as_profit(seeded_db):
    """用户裁决 C：挂单押金占用进 R2 直接成本、释放进收入；损失按「收入−支出」
    净额体现、不另记第二次现金流；R2 订单贡献与订单利润逐笔同源。"""
    from app.orders.create import create_order
    from app.shared.order_amounts import order_cashflow_profit_by_order

    order = create_order(
        seeded_db, order_type="TH", owner_id=1, trade_date=TODAY, actor="pytest"
    )
    invest = _pool(seeded_db, "HJ_INVEST")

    def r2_oct():
        data = r2_monthly_pnl(seeded_db)
        item = next((r for r in data["items"] if r["month"] == "2026-10"), None)
        return (
            item["cost"] if item else Decimal("0.00"),
            item["sales_income"] if item else Decimal("0.00"),
            item["operating_expense"] if item else Decimal("0.00"),
        )

    cost0, income0, op0 = r2_oct()
    profit0 = order_cashflow_profit_by_order(seeded_db, order_ids=[order.id]).get(
        order.id, Decimal("0.00")
    )

    # 占用 2000：进 R2 直接成本、进订单利润支出侧。
    dep = create_deposit(
        seeded_db, pool_id=invest.id, amount=Decimal("2000"), paid_on=TODAY,
        source_order_id=order.id, actor="pytest",
    )
    seeded_db.expire_all()
    cost1, income1, op1 = r2_oct()
    assert cost1 == cost0 + Decimal("2000"), (
        f"[BUG] 押金占用未进 R2 直接成本（裁决 C）: {cost0}->{cost1}"
    )
    assert income1 == income0
    assert op1 == op0, "挂单押金占用不得进 R2 运营费用段2"
    assert order_cashflow_profit_by_order(seeded_db, order_ids=[order.id])[order.id] == (
        profit0 - Decimal("2000")
    )

    # 损失 500：不是第二次现金流出——R2 直接成本、订单利润都不再减。
    lose_deposit(
        seeded_db, dep.id, amount=Decimal("500"), lost_on=TODAY,
        category="OPERATING_COST", reason="对方违约", actor="finance", operator_user_ids=[1],
    )
    seeded_db.expire_all()
    cost2, income2, op2 = r2_oct()
    assert cost2 == cost1, f"[BUG] 押金损失被重复计入 R2 直接成本: {cost1}->{cost2}"
    assert op2 == op0, "[BUG] 挂单押金损失漏进 R2 运营费用段2（净额只在段1体现一次）"
    assert order_cashflow_profit_by_order(seeded_db, order_ids=[order.id])[order.id] == (
        profit0 - Decimal("2000")
    )

    # 退回 1500：进 R2 收入；净额 = 收入1500 − 支出2000 = −500 = 损失。
    return_deposit(
        seeded_db, dep.id, amount=Decimal("1500"), released_on=TODAY, actor="pytest",
    )
    seeded_db.expire_all()
    cost3, income3, op3 = r2_oct()
    assert op3 == op0, "挂单押金退回不得进 R2 运营费用段2"
    assert income3 == income0 + Decimal("1500")
    assert cost3 == cost0 + Decimal("2000")
    # R2 押金线净额与订单利润逐笔同源：均为 −500，损失不重复。
    r2_net = (income3 - income0) - (cost3 - cost0)
    profit3 = order_cashflow_profit_by_order(seeded_db, order_ids=[order.id])[order.id]
    assert r2_net == Decimal("-500")
    assert profit3 == profit0 - Decimal("500")
    assert r2_net == profit3 - profit0


def test_order_linked_normal_expense_still_in_r2_direct_cost(seeded_db):
    """守卫：挂订单的普通经营支出（非押金）仍进 R2 直接成本（NULL 属性不被误删）。"""
    from app.orders.create import create_order
    order = create_order(
        seeded_db, order_type="TH", owner_id=1, trade_date=TODAY, actor="pytest"
    )
    invest = _pool(seeded_db, "HJ_INVEST")
    base = r2_monthly_pnl(seeded_db)
    oct_before = next((r for r in base["items"] if r["month"] == "2026-10"), None)
    before_cost = oct_before["cost"] if oct_before else Decimal("0.00")

    # accounting_attribute=None 的挂单支出，验证 != DEPOSIT 的 NULL 放行
    _flow(seeded_db, pool_id=invest.id, direction="OUT", nature="BUSINESS_OUT",
          amount="300", attribute=None, order_id=order.id)
    after = r2_monthly_pnl(seeded_db)
    oct_item = next(r for r in after["items"] if r["month"] == "2026-10")
    assert oct_item["cost"] == before_cost + Decimal("300.00")


# ----------------------------------------------- #5 外部注入进入收入
def test_external_in_updates_income(seeded_db):
    """外部注入进入资金账户收入，余额与收入同源。"""
    invest = _pool(seeded_db, "HJ_INVEST")
    before = pool_balance(seeded_db, invest.id)
    _flow(seeded_db, pool_id=invest.id, direction="IN",
          nature=Nature.EXTERNAL_IN.value, amount="5000")

    after = pool_balance(seeded_db, invest.id)
    assert after["income"] == before["income"] + Decimal("5000.00")


# ------------------------ 售出价 / 返点是收入子类型：进 income，不单列（2026-11-12 裁决）
def test_sale_and_rebate_are_income_subtypes_not_separate_columns(seeded_db):
    """售出(SELL)/返点(REBATE)流水源头都是 IN/BUSINESS_IN，进收入方向不单列。

    返点流水源头见 finance/rebates.py:168-174（IN/BUSINESS_IN/category=REBATE）；
    售出见 orders/events.py:50（IN/BUSINESS_IN/"SELL"）。
    """
    invest = _pool(seeded_db, "HJ_INVEST")
    before = pool_balance(seeded_db, invest.id)
    _flow(seeded_db, pool_id=invest.id, direction="IN", nature="BUSINESS_IN",
          amount="8000", category="SELL")
    _flow(seeded_db, pool_id=invest.id, direction="IN", nature="BUSINESS_IN",
          amount="500", category="REBATE")

    after = pool_balance(seeded_db, invest.id)
    assert after["income"] == before["income"] + Decimal("8500.00")


# ------------------------ 回收价 / 提号价是支出子类型：进 expense，不单列（2026-11-12 裁决）
def test_buy_amounts_are_expense_subtypes_not_separate_columns(seeded_db):
    """回收(HS)/提号(TH)买入流水源头都是 OUT/BUSINESS_OUT，进支出方向不单列。

    BUY 源头见 orders/events.py:49（OUT/BUSINESS_OUT/"BUY"）。
    """
    invest = _pool(seeded_db, "HJ_INVEST")
    before = pool_balance(seeded_db, invest.id)
    _flow(seeded_db, pool_id=invest.id, direction="OUT", nature="BUSINESS_OUT",
          amount="3000", category="BUY")
    _flow(seeded_db, pool_id=invest.id, direction="OUT", nature="BUSINESS_OUT",
          amount="2000", category="BUY")

    after = pool_balance(seeded_db, invest.id)
    assert after["expense"] == before["expense"] + Decimal("5000.00")


# ------------ 内部划转：划出账户记支出、划入账户记收入，不单列第三方向（2026-11-12 裁决）
def test_internal_transfer_is_expense_of_source_income_of_target(seeded_db):
    """同一笔划转：划出池 expense +、划入池 income +；资金日报无独立划转方向列。"""
    invest = _pool(seeded_db, "HJ_INVEST")
    profit = _pool(seeded_db, "HJ_PROFIT")
    before_src = pool_balance(seeded_db, invest.id)
    before_tgt = pool_balance(seeded_db, profit.id)
    tid = "TRF-TEST-001"
    _flow(seeded_db, pool_id=invest.id, direction="OUT", nature="INTERNAL",
          amount="300", category="TRANSFER", source_type=CashflowSourceType.TRANSFER.value, source_id=tid)
    _flow(seeded_db, pool_id=profit.id, direction="IN", nature="INTERNAL",
          amount="300", category="TRANSFER", source_type=CashflowSourceType.TRANSFER.value, source_id=tid)
    seeded_db.expire_all()

    after_src = pool_balance(seeded_db, invest.id)
    after_tgt = pool_balance(seeded_db, profit.id)
    assert after_src["expense"] == before_src["expense"] + Decimal("300.00")
    assert after_src["income"] == before_src["income"], "划出账户不应因此增加收入"
    assert after_tgt["income"] == before_tgt["income"] + Decimal("300.00")
    assert after_tgt["expense"] == before_tgt["expense"], "划入账户不应因此增加支出"



# ============ 押金一套逻辑：净额=收入−支出，+利润/−损失（2026-11-12 用户裁决） ============
def test_deposit_loss_not_double_counted_in_funds_and_profit(seeded_db):
    """缴1000→损300→退700：资金中心支出只1000、收入700、净额−300（利润=−300，
    损失=−利润=300，不另记第二次 OUT）；订单利润同口径；报表侧 cashflow_totals_by_order
    与利润明细同源。"""
    from app.orders.create import create_order
    from app.shared.order_amounts import order_cashflow_profit_by_order
    from app.reporting._shared import cashflow_totals_by_order

    order = create_order(
        seeded_db, order_type="TH", owner_id=1, trade_date=TODAY, actor="pytest"
    )
    invest = _pool(seeded_db, "HJ_INVEST")
    before = pool_balance(seeded_db, invest.id)
    profit0 = order_cashflow_profit_by_order(seeded_db, order_ids=[order.id]).get(order.id, Decimal("0"))

    dep = create_deposit(
        seeded_db, pool_id=invest.id, amount=Decimal("1000"), paid_on=TODAY,
        source_order_id=order.id, actor="pytest",
    )
    seeded_db.expire_all()
    after_hold = pool_balance(seeded_db, invest.id)
    # 交押金 = 支出，进资金中心 expense；订单利润 −1000
    assert after_hold["expense"] == before["expense"] + Decimal("1000")
    assert order_cashflow_profit_by_order(seeded_db, order_ids=[order.id])[order.id] == profit0 - Decimal("1000")

    # 损失 300：不是第二次现金流出——资金中心 expense / cash_balance 不再变
    lose_deposit(
        seeded_db, dep.id, amount=Decimal("300"), lost_on=TODAY,
        category="OPERATING_COST", reason="对方违约", actor="finance", operator_user_ids=[1],
    )
    seeded_db.expire_all()
    after_loss = pool_balance(seeded_db, invest.id)
    assert after_loss["expense"] == after_hold["expense"], (
        f"[BUG] 押金损失被当成第二次现金流出，虚增 expense: {after_hold['expense']}->{after_loss['expense']}"
    )
    assert after_loss["cash_balance"] == after_hold["cash_balance"], (
        f"[BUG] 押金损失虚减现金: {after_hold['cash_balance']}->{after_loss['cash_balance']}"
    )
    assert after_loss["deposit_held"] == Decimal("700.00")
    # 订单利润也不因损失再减 300（否则净损失翻倍 600）
    assert order_cashflow_profit_by_order(seeded_db, order_ids=[order.id])[order.id] == profit0 - Decimal("1000")

    # 押金回来 700 = 收入
    return_deposit(
        seeded_db, dep.id, amount=Decimal("700"), released_on=TODAY, actor="pytest",
    )
    seeded_db.expire_all()
    after_ret = pool_balance(seeded_db, invest.id)
    assert after_ret["income"] == before["income"] + Decimal("700")
    assert after_ret["expense"] == after_hold["expense"], "退回不改变支出侧"
    # 现金净流出 = 支出1000 − 收入700 = 300 = 押金线净损失
    assert after_ret["cash_balance"] == before["cash_balance"] - Decimal("300")
    assert after_ret["deposit_held"] == Decimal("0.00")

    # 订单利润 = 收入700 − 支出1000 = −300（等于损失，不重复）
    profit1 = order_cashflow_profit_by_order(seeded_db, order_ids=[order.id])[order.id]
    assert profit1 == profit0 - Decimal("300")
    # 报表侧同源：income−expense 与订单利润一致（buy 其中项不影响）
    rep_income, rep_expense, _buy = cashflow_totals_by_order(seeded_db, order_ids=[order.id])[order.id]
    assert rep_income - rep_expense == profit1, (
        f"[BUG] 报表取数与订单利润明细不同源: {rep_income}-{rep_expense} != {profit1}"
    )


# ============ 裁决：押金占用 available 不二次扣（缴1000 → 可用只减1000，非2000） ============
def test_deposit_hold_available_not_deducted_twice(seeded_db):
    """支出口径：押金占用已进 expense、在 cash_balance 扣过一次，available=cash_balance。

    deposit_held 仅作「其中：押金占用」信息列，不再从 available 二次扣减
    （缴 1000：cash −1000、available −1000，合计只影响一次）。
    """
    invest = _pool(seeded_db, "HJ_INVEST")
    before = pool_balance(seeded_db, invest.id)
    create_deposit(
        seeded_db, pool_id=invest.id, amount=Decimal("1000"),
        paid_on=TODAY, actor="pytest",
    )
    seeded_db.expire_all()
    after = pool_balance(seeded_db, invest.id)
    assert after["cash_balance"] == before["cash_balance"] - Decimal("1000")
    assert after["deposit_held"] == Decimal("1000.00")
    # 关键守卫：available 等于现金余额，不再二次减 deposit_held
    assert after["available"] == after["cash_balance"]
    assert after["available"] == before["available"] - Decimal("1000")


def test_deposit_loss_null_attribute_other_flows_not_dropped(seeded_db):
    """守卫 SQL 三值逻辑：business_cashflow_filter 不得误删 accounting_attribute=NULL 的普通流水。"""
    from app.orders.create import create_order
    from app.shared.order_amounts import order_cashflow_profit_by_order
    order = create_order(
        seeded_db, order_type="TH", owner_id=1, trade_date=TODAY, actor="pytest"
    )
    invest = _pool(seeded_db, "HJ_INVEST")
    before = pool_balance(seeded_db, invest.id)
    # 无属性的挂单支出（普通经营流水）：accounting_attribute=NULL
    # SQL 中 NULL != 'DEPOSIT' 为假，若过滤写成 != 会误删本行——正向条件须放行 NULL。
    _flow(seeded_db, pool_id=invest.id, direction="OUT", nature="BUSINESS_OUT",
          amount="250", attribute=None, order_id=order.id)
    seeded_db.expire_all()
    assert order_cashflow_profit_by_order(seeded_db, order_ids=[order.id])[order.id] == Decimal("-250.00")
    after = pool_balance(seeded_db, invest.id)
    assert after["expense"] == before["expense"] + Decimal("250.00"), (
        "[BUG] accounting_attribute=NULL 的普通流水被 business_cashflow_filter 误删"
    )
