"""返点退回口径契约（2026-11-12 用户裁决）。

返点登记即确认收入、不提供作废/删除；确实要退回该笔钱时，在来源订单上记
一笔真实挂单 OUT 支出（REBATE_REVERSAL），发生日=真实退回日。核心红线：
- 挂单 OUT 才能冲减该订单利润（利润=收入−支出），独立流水不挂单是缺陷；
- 累计退回不得超过该笔返点金额（防重复/超额）；
- 归期按真实退回日，不用 date.today() 撕裂 R2 / 资金日报；
- R2 因 op_stmt 的 order_id.is_(None) 不会把挂单退回重复计入运营费用。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.core.errors import Validation
from app.core.money import to_money
from app.domain.enums import RebateStatus
from app.domain.trade import Cashflow, RebateRecord
from app.finance import rebates
from app.orders.amounts import order_cashflow_profit
from app.orders.create import create_order
from app.orders.events import post_event
from app.reporting.r2_monthly_pnl import r2_monthly_pnl
from app.stocks.profile import create_account

D = date(2026, 10, 17)
RETURN_D = date(2026, 11, 12)


def _order_with_sell_rebate(seeded_db, base: str = "1000", collected_on: date = D) -> tuple[int, int]:
    """造一个 HS 订单（BUY+SELL），再登记一笔新模型返点，返回 (order_id, rebate_id)。"""
    account = create_account(
        seeded_db,
        game_account=f"rebate-return-{uuid4().hex[:8]}",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    )
    order = create_order(
        seeded_db,
        order_type="HS",
        owner_id=1,
        trade_date=D,
        actor="pytest",
        account_id=account.id,
    )
    post_event(
        seeded_db, order.id, event_type="BUY", amount=Decimal("600"),
        occurred_on=D, actor="pytest", pool_id=1,
    )
    post_event(
        seeded_db, order.id, event_type="SELL", amount=Decimal("1500"),
        occurred_on=D, actor="pytest", pool_id=1,
    )
    record = rebates.create_rebate(
        seeded_db,
        source_order_id=order.id,
        rebate_type="SELL",
        base_amount=Decimal(base),
        rate=Decimal("5"),
        collected_on=collected_on,
        actor="pytest",
    )
    return order.id, record.id


def test_return_creates_linked_outflow_and_reduces_order_profit(seeded_db):
    """退回形成挂单 OUT，订单利润按「收入−支出」自动冲减。"""
    order_id, rebate_id = _order_with_sell_rebate(seeded_db, base="1000")
    before = order_cashflow_profit(seeded_db, order_id)

    record, flow, already = rebates.return_rebate(
        seeded_db, rebate_id=rebate_id, amount=Decimal("400"),
        returned_on=RETURN_D, actor="pytest",
    )

    assert record.status == RebateStatus.SETTLED.value  # 返点记录不作废
    assert flow.direction == "OUT"
    assert flow.nature == "BUSINESS_OUT"
    assert flow.category == "REBATE_REVERSAL"
    assert flow.accounting_attribute == "REVERSAL"
    assert flow.order_id == order_id
    assert (flow.form_extra or {}).get("rebate_record_id") == rebate_id
    assert flow.occurred_on == RETURN_D
    assert already == Decimal("400.00")
    # 挂单 OUT 进支出侧：利润恰好减少本次退回额。
    assert order_cashflow_profit(seeded_db, order_id) == before - Decimal("400")


def test_partial_returns_accumulate_and_over_return_rejected(seeded_db):
    """同一返点可分多次部分退回，累计超 base_amount 拒绝。"""
    order_id, rebate_id = _order_with_sell_rebate(seeded_db, base="1000")

    rebates.return_rebate(seeded_db, rebate_id=rebate_id, amount=Decimal("600"),
                          returned_on=RETURN_D, actor="pytest")
    record, flow, already = rebates.return_rebate(
        seeded_db, rebate_id=rebate_id, amount=Decimal("400"),
        returned_on=RETURN_D, actor="pytest",
    )
    assert already == Decimal("1000.00")

    # 再退 0.01 即超额，应拒绝且不产生流水。
    flows_before = seeded_db.scalars(
        select(Cashflow).where(Cashflow.category == "REBATE_REVERSAL")
    ).all()
    with pytest.raises(Validation):
        rebates.return_rebate(seeded_db, rebate_id=rebate_id, amount=Decimal("0.01"),
                              returned_on=RETURN_D, actor="pytest")
    flows_after = seeded_db.scalars(
        select(Cashflow).where(Cashflow.category == "REBATE_REVERSAL")
    ).all()
    assert len(flows_after) == len(flows_before)


def test_return_uses_real_return_date_not_today(seeded_db):
    """归期=真实退回日（11月），不撕裂 10月返点登记月的 R2。"""
    order_id, rebate_id = _order_with_sell_rebate(seeded_db, base="1000", collected_on=D)
    before = r2_monthly_pnl(seeded_db)
    oct_before = next(r for r in before["items"] if r["month"] == "2026-10")

    rebates.return_rebate(seeded_db, rebate_id=rebate_id, amount=Decimal("250"),
                          returned_on=RETURN_D, actor="pytest")

    after = r2_monthly_pnl(seeded_db)
    oct_after = next(r for r in after["items"] if r["month"] == "2026-10")
    nov_after = next((r for r in after["items"] if r["month"] == "2026-11"), None)
    # 10月销售收入（含返点 IN 流水）不变；退回支出落在 11月直接成本。
    assert oct_after["sales_income"] == oct_before["sales_income"]
    assert oct_after["account_direct_cost"] == oct_before["account_direct_cost"]
    assert nov_after is not None
    assert nov_after["account_direct_cost"] == Decimal("250.00")
    # 「其中返点」列仍是 10月登记的 1000，不受退回影响（展示口径）。
    assert oct_after["rebate_income"] == Decimal("1000.00")


def test_return_does_not_inflate_operating_expense(seeded_db):
    """挂单退回只进该单直接成本，不得重复进 R2 运营费用列。"""
    order_id, rebate_id = _order_with_sell_rebate(seeded_db, base="1000")
    before = r2_monthly_pnl(seeded_db)
    op_before = next((r["operating_expense"] for r in before["items"] if r["month"] == "2026-11"), Decimal("0"))

    rebates.return_rebate(seeded_db, rebate_id=rebate_id, amount=Decimal("300"),
                          returned_on=RETURN_D, actor="pytest")

    after = r2_monthly_pnl(seeded_db)
    nov = next(r for r in after["items"] if r["month"] == "2026-11")
    assert nov["operating_expense"] == op_before  # 运营费用不受挂单退回影响
    assert nov["account_direct_cost"] == Decimal("300.00")


def test_return_flow_reuses_original_rebate_pool(seeded_db):
    """退回流水与返点登记 IN 流水同池（收支同池）。"""
    order_id, rebate_id = _order_with_sell_rebate(seeded_db, base="1000")
    original = seeded_db.scalar(
        select(Cashflow).where(
            Cashflow.order_id == order_id,
            Cashflow.category == "REBATE",
            Cashflow.direction == "IN",
        )
    )
    assert original is not None
    _record, flow, _already = rebates.return_rebate(
        seeded_db, rebate_id=rebate_id, amount=Decimal("100"),
        returned_on=RETURN_D, actor="pytest",
    )
    assert flow.pool_id == original.pool_id


def test_return_rejects_zero_amount(seeded_db):
    """退回金额必须为正。"""
    _order_id, rebate_id = _order_with_sell_rebate(seeded_db, base="1000")
    with pytest.raises(Validation):
        rebates.return_rebate(seeded_db, rebate_id=rebate_id, amount=Decimal("0"),
                              returned_on=RETURN_D, actor="pytest")


def test_list_exposes_already_returned_and_remaining(seeded_db):
    """列表/单查下发累计已退与可退余额，口径收敛到后端，前端不再自算减法。"""
    from app.finance.rebates import rebate_returned_totals

    order_id, rebate_id = _order_with_sell_rebate(seeded_db, base="1000")
    record = seeded_db.get(RebateRecord, rebate_id)

    # 未退时已退=0、可退=基数。
    totals = rebate_returned_totals(seeded_db, [record])
    assert totals[rebate_id] == Decimal("0.00")
    assert Decimal("1000.00") == record.base_amount - totals[rebate_id]

    # 退 400 后：已退=400、可退=600。
    rebates.return_rebate(seeded_db, rebate_id=rebate_id, amount=Decimal("400"),
                          returned_on=RETURN_D, actor="pytest")
    totals = rebate_returned_totals(seeded_db, [record])
    assert totals[rebate_id] == Decimal("400.00")

    from app.finance.router_output import _rebate_out

    out = _rebate_out(record, totals[rebate_id])
    assert out.already_returned == Decimal("400.00")
    assert out.remaining == Decimal("600.00")


def test_return_remaining_is_derived_from_rebate(seeded_db):
    """退回结果的 remaining 为计算字段，等于返点可退余额，不重复相减。"""
    from app.finance.schemas import RebateReturnOut

    order_id, rebate_id = _order_with_sell_rebate(seeded_db, base="1000")
    record, flow, already = rebates.return_rebate(
        seeded_db, rebate_id=rebate_id, amount=Decimal("250"),
        returned_on=RETURN_D, actor="pytest",
    )
    from app.finance.router_output import _cashflow_out, _rebate_out

    result = RebateReturnOut(
        rebate=_rebate_out(record, already),
        cashflow=_cashflow_out(seeded_db, flow),
        already_returned=already,
    )
    assert result.already_returned == Decimal("250.00")
    assert result.remaining == Decimal("750.00")


def test_update_base_below_already_returned_rejected(seeded_db):
    """护栏：把基数改到低于累计已退会架空『累计退回≤金额』，必须拒绝。"""
    order_id, rebate_id = _order_with_sell_rebate(seeded_db, base="1000")
    rebates.return_rebate(seeded_db, rebate_id=rebate_id, amount=Decimal("600"),
                          returned_on=RETURN_D, actor="pytest")

    # 改到低于已退 600 → 拒绝。
    with pytest.raises(Validation):
        rebates.update_rebate(seeded_db, rebate_id, base_amount=Decimal("500"), actor="pytest")

    # 改到等于已退 → 允许（可退余额归零）。
    updated = rebates.update_rebate(seeded_db, rebate_id, base_amount=Decimal("600"), actor="pytest")
    assert updated.base_amount == Decimal("600.00")


def test_void_legacy_rebate_cannot_return(seeded_db):
    """历史已作废（VOID）返点不可再退回。"""
    order_id, _ = _order_with_sell_rebate(seeded_db, base="1000")
    legacy = RebateRecord(
        rebate_no=f"REB-LEGACY-{uuid4().hex[:8]}",
        source_order_id=order_id,
        rebate_type="SELL",
        rate=to_money("5"),
        base_amount=to_money("500"),
        collected_on=D,
        status=RebateStatus.VOID.value,
        link_status="LINKED",
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(legacy)
    seeded_db.flush()
    with pytest.raises(Validation):
        rebates.return_rebate(seeded_db, rebate_id=legacy.id, amount=Decimal("100"),
                              returned_on=RETURN_D, actor="pytest")
