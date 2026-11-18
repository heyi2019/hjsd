"""PROFIT-02 分润基数 = 该订单所有收入 − 所有支出（2026-11-05 用户裁决）。

关键守卫：利润不再由 SELL/BUY/COST 事件推导。资金走向只有收入 / 支出两种，
返点记录（收入）与分期坏账（支出）即使不生成资金流水，也必须计入利润；
且与订单详情「资金明细」同源——页面上多一笔独立收支，分润基数立刻跟着变。
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest

from app.core.errors import Validation
from app.core.money import to_money
from app.domain.enums import (
    InstallmentContractType,
    InstallmentDispositionAction,
    LinkStatus,
    Nature,
    RebateStatus,
    RebateType,
)
from app.domain.trade import (
    Cashflow,
    Installment,
    InstallmentDisposition,
    Order,
    OrderEvent,
    RebateRecord,
)
from app.orders.create import create_order
from app.orders.events import post_event
from app.shared.order_amounts import (
    event_totals,
    order_amounts,
    order_cashflow_profit_by_order,
)
from app.reporting._shared import cashflow_totals_by_order
from app.orders.router_output import _order_list_payload
from app.policy.profit_allocation import service as policy_allocations
from app.reporting.profit import order_profit_detail
from app.reporting.r2_monthly_pnl import r2_monthly_pnl
from app.reporting.r3_commission import r3_commission_reconciliation
from app.reporting.r5_business_pnl import r5_business_pnl
from app.stocks.profile import create_account
from sqlalchemy import select

D = date(2026, 10, 17)


def _order_with_events(seeded_db, *, buy: str = "1000", sell: str = "1500") -> int:
    account = create_account(
        seeded_db,
        game_account=f"cashbasis-{buy}-{sell}-{uuid4().hex[:6]}",
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
        seeded_db, order.id, event_type="BUY", amount=Decimal(buy),
        occurred_on=D, actor="pytest", pool_id=1,
    )
    post_event(
        seeded_db, order.id, event_type="SELL", amount=Decimal(sell),
        occurred_on=D, actor="pytest", pool_id=1,
    )
    return order.id


def _add_flow(seeded_db, order_id: int, direction: str, amount: str) -> None:
    """造一笔与业务事件无关的独立资金流水，只有资金明细口径才会把它算进去。"""
    seeded_db.add(
        Cashflow(
            flow_no=f"CF-PROFIT-{uuid4().hex[:10]}",
            pool_id=1,
            occurred_on=D,
            nature=Nature.BUSINESS_IN.value if direction == "IN" else Nature.BUSINESS_OUT.value,
            direction=direction,
            category="OTHER",
            amount=to_money(amount),
            order_id=order_id,
            created_by="pytest",
            updated_by="pytest",
        )
    )
    seeded_db.flush()


def _add_rebate(seeded_db, order_id: int, amount: str) -> None:
    """返点登记即收入确认（见 finance/rebates.py），不生成资金流水。"""
    seeded_db.add(
        RebateRecord(
            rebate_no=f"REB-{uuid4().hex[:10]}",
            source_order_id=order_id,
            rebate_type=RebateType.SELL.value,
            amount=to_money(amount),
            collected_on=D,
            status=RebateStatus.SETTLED.value,
            link_status=LinkStatus.LINKED.value,
            created_by="pytest",
            updated_by="pytest",
        )
    )
    seeded_db.flush()


def _add_bad_debt(seeded_db, order_id: int, amount: str) -> None:
    """分期回收确认坏账损失，同样不生成资金流水。"""
    order = seeded_db.get(Order, order_id)
    contract = Installment(
        inst_no=f"INST-{uuid4().hex[:10]}",
        order_id=order_id,
        contract_type=InstallmentContractType.STOCK_SALE.value,
        principal=to_money("1000"),
        down_payment=to_money("0"),
        service_fee=to_money("0"),
        periods=1,
        per_period_service_fee=to_money("0"),
        per_period=to_money("1000"),
        paid_amount=to_money("0"),
        waived_amount=to_money("0"),
        bad_debt_amount=to_money(amount),
        first_due_on=D,
        created_by="pytest",
        updated_by="pytest",
    )
    seeded_db.add(contract)
    seeded_db.flush()
    seeded_db.add(
        InstallmentDisposition(
            installment_id=contract.id,
            account_id=order.account_id,
            action=InstallmentDispositionAction.RECOVER.value,
            occurred_on=D,
            note="pytest 坏账确认",
            created_by="pytest",
            updated_by="pytest",
        )
    )
    seeded_db.flush()


def test_profit_follows_cashflow_not_events(seeded_db):
    """事件口径仍是 500，资金明细多一笔 200 支出后利润变成 300。"""
    order_id = _order_with_events(seeded_db)
    events = list(
        seeded_db.scalars(select(OrderEvent).where(OrderEvent.order_id == order_id)).all()
    )
    income, buy, cost = event_totals(events)
    assert income - buy - cost == Decimal("500.00")
    assert order_amounts(seeded_db, order_id)["PROFIT"] == Decimal("500.00")

    _add_flow(seeded_db, order_id, "OUT", "200")

    assert order_amounts(seeded_db, order_id)["PROFIT"] == Decimal("300.00")
    # 成交额 / 本金仍按事件口径，不受资金明细影响。
    assert order_amounts(seeded_db, order_id)["GROSS"] == Decimal("1500.00")
    assert order_amounts(seeded_db, order_id)["PRINCIPAL"] == Decimal("1000.00")


def test_order_ledger_profit_uses_cashflow_basis(seeded_db):
    """订单台账利润必须与利润分配同源，额外资金支出应同步扣减。"""
    order_id = _order_with_events(seeded_db)
    _add_flow(seeded_db, order_id, "OUT", "200")

    order = seeded_db.get(Order, order_id)
    row = _order_list_payload(seeded_db, [order])[0]

    assert row["profit_base"] == Decimal("300.00")


def test_order_ledger_sale_amount_uses_sell_events_only(seeded_db):
    """台账售出金额只取 SELL，不把 BUY 事件合进展示金额。"""
    order_id = _order_with_events(seeded_db, buy="1000", sell="1500")

    order = seeded_db.get(Order, order_id)
    row = _order_list_payload(seeded_db, [order])[0]

    assert row["sale_amount"] == Decimal("1500.00")
    assert "event_total" not in row


def test_order_ledger_profit_includes_rebate_and_bad_debt(seeded_db):
    """台账利润也必须包含不生成资金流水的返点收入与分期坏账。"""
    order_id = _order_with_events(seeded_db)
    _add_rebate(seeded_db, order_id, "100")
    _add_bad_debt(seeded_db, order_id, "400")

    order = seeded_db.get(Order, order_id)
    row = _order_list_payload(seeded_db, [order])[0]

    assert row["profit_base"] == Decimal("200.00")


def test_profit_counts_all_income_and_expense(seeded_db):
    """独立收入同样计入；收支相等为 0，只有支出为负。"""
    order = create_order(
        seeded_db, order_type="HS", owner_id=1, trade_date=D, actor="pytest"
    )
    assert order_amounts(seeded_db, order.id)["PROFIT"] == Decimal("0.00")

    _add_flow(seeded_db, order.id, "OUT", "800")
    assert order_amounts(seeded_db, order.id)["PROFIT"] == Decimal("-800.00")

    _add_flow(seeded_db, order.id, "IN", "800")
    assert order_amounts(seeded_db, order.id)["PROFIT"] == Decimal("0.00")

    _add_flow(seeded_db, order.id, "IN", "1200")
    assert order_amounts(seeded_db, order.id)["PROFIT"] == Decimal("1200.00")


def test_allocation_amount_boundary_uses_cashflow_profit(seeded_db):
    """利润 300：按金额分 400 拒绝、300 放行——校验边界确实换了基数。"""
    order_id = _order_with_events(seeded_db)
    _add_flow(seeded_db, order_id, "OUT", "200")

    with pytest.raises(Validation, match="超过订单利润"):
        policy_allocations.set_allocations(
            seeded_db, order_id,
            items=[{"user_id": 1, "role": "OWNER", "allocation_amount": "400"}],
        )

    rows = policy_allocations.set_allocations(
        seeded_db, order_id,
        items=[{"user_id": 1, "role": "OWNER", "allocation_amount": "300"}],
    )
    assert rows[0]["total_amount"] == "300.00"


def test_r3_rate_allocation_uses_cashflow_profit(seeded_db):
    """按比例分润：报表 profit_base = 资金明细利润 × 比例。"""
    order_id = _order_with_events(seeded_db)
    _add_flow(seeded_db, order_id, "OUT", "200")
    policy_allocations.set_allocations(
        seeded_db, order_id,
        items=[
            {"user_id": 1, "role": "OWNER", "allocation_rate": "50"},
            {"user_id": 2, "role": "OWNER", "allocation_rate": "50"},
        ],
    )

    report = r3_commission_reconciliation(seeded_db)
    entries = [row for group in report["order_groups"] for row in group["orders"]]
    assert sorted(row["profit_base"] for row in entries) == [
        Decimal("150.00"), Decimal("150.00"),
    ]


def test_api_order_profit_uses_cashflow_basis(seeded_client, seeded_db, headers):
    """分润弹窗顶部显示的「订单总利润」由 GET 接口下发，必须同步新口径。"""
    order_id = _order_with_events(seeded_db)
    _add_flow(seeded_db, order_id, "OUT", "200")

    response = seeded_client.get(
        f"/api/v1/orders/{order_id}/profit-allocations", headers=headers
    )

    assert response.status_code == 200, response.text
    assert Decimal(response.json()["order_profit"]) == Decimal("300.00")


def test_rebate_is_income_and_bad_debt_is_expense(seeded_db):
    """返点=收入、坏账=支出；两项都不生成资金流水，但必须进利润。"""
    order_id = _order_with_events(seeded_db)
    assert order_amounts(seeded_db, order_id)["PROFIT"] == Decimal("500.00")

    flow_count = len(
        seeded_db.scalars(
            select(Cashflow).where(Cashflow.order_id == order_id)
        ).all()
    )
    _add_rebate(seeded_db, order_id, "100")
    assert order_amounts(seeded_db, order_id)["PROFIT"] == Decimal("600.00")

    _add_bad_debt(seeded_db, order_id, "400")
    assert order_amounts(seeded_db, order_id)["PROFIT"] == Decimal("200.00")
    # 没有新增 cashflow 行：「是否生成流水」不能作为排除资金走向的理由。
    assert len(
        seeded_db.scalars(
            select(Cashflow).where(Cashflow.order_id == order_id)
        ).all()
    ) == flow_count


def test_reports_follow_rebate_and_bad_debt(seeded_db):
    """RPT-01 / R2 / R5 与分润基数同源，返点列只作其中项展示。"""
    order_id = _order_with_events(seeded_db)
    _add_rebate(seeded_db, order_id, "100")
    _add_bad_debt(seeded_db, order_id, "400")

    detail = order_profit_detail(seeded_db)
    item = next(row for row in detail["items"] if row["order_id"] == order_id)
    assert item["income"] == Decimal("1600.00")  # 1500 售出 + 100 返点
    assert item["cost"] == Decimal("1400.00")  # 采购支出与坏账统一计入成本
    assert item["rebate"] == Decimal("100.00")
    assert item["net_profit"] == Decimal("200.00")

    # 跨报表一致性契约仍成立（既有红线）。
    r5 = r5_business_pnl(seeded_db)
    assert r5["total"]["main_profit"] == detail["total"]["net_profit"]

    monthly = r2_monthly_pnl(seeded_db)
    oct_item = next(row for row in monthly["items"] if row["month"] == "2026-10")
    assert oct_item["rebate_income"] == Decimal("100.00")
    # 返点已含在销售收入里，不重复加回经营利润。
    assert oct_item["operating_profit"] == (
        oct_item["sales_income"]
        - oct_item["cost"]
        - oct_item["operating_expense"]
    )


def test_r2_rebate_column_counts_action_model_rebate_like_profit_detail(seeded_db):
    """R2「其中返点」列与利润明细同源：新模型返点(自动生成IN流水)也必须进列。

    回归：旧口径 R2 的 rebate_income 复用 order_profit_flow_by_date 的 extra_income，
    而后者对「已生成资金流水的新模型返点」continue 防重复，连带把其中项展示也跳过，
    导致同一笔新模型返点在 R2 列=0、利润明细列=amount 口径打架（2026-11-12 修）。
    """
    from app.finance.rebates import create_rebate

    order_id = _order_with_events(seeded_db)  # HS，BUY+SELL，D=2026-10-17
    # 新模型返点：create_rebate 同时生成 IN 资金流水（amount 计入 sales_income）
    create_rebate(
        seeded_db, source_order_id=order_id, rebate_type="SELL",
        amount=Decimal("250"),
        collected_on=D, actor="pytest",
    )

    # 利润明细「其中返点」列 = 250
    detail = order_profit_detail(seeded_db)
    ditem = next(row for row in detail["items"] if row["order_id"] == order_id)
    assert ditem["rebate"] == Decimal("250.00")
    assert ditem["income"] >= Decimal("250.00")  # 已含在收入大类

    # R2「其中返点」列必须与利润明细同源 = 250（改动前这里是 0）
    monthly = r2_monthly_pnl(seeded_db)
    oct_item = next(row for row in monthly["items"] if row["month"] == "2026-10")
    assert oct_item["rebate_income"] == ditem["rebate"] == Decimal("250.00")
    # 其中项只作展示，不重复加回经营利润
    assert oct_item["operating_profit"] == (
        oct_item["sales_income"]
        - oct_item["cost"]
        - oct_item["operating_expense"]
    )


def test_r3_allocation_includes_rebate_and_bad_debt(seeded_db):
    """R3 提成基数 = 200（含返点收入、坏账支出），50% 分成为 100。"""
    order_id = _order_with_events(seeded_db)
    _add_rebate(seeded_db, order_id, "100")
    _add_bad_debt(seeded_db, order_id, "400")
    policy_allocations.set_allocations(
        seeded_db, order_id,
        items=[
            {"user_id": 1, "role": "OWNER", "allocation_rate": "50"},
            {"user_id": 2, "role": "OWNER", "allocation_rate": "50"},
        ],
    )

    report = r3_commission_reconciliation(seeded_db)
    entries = [
        row
        for group in report["order_groups"]
        for row in group["orders"]
        if row["order_id"] == order_id
    ]
    assert sorted(row["profit_base"] for row in entries) == [
        Decimal("100.00"), Decimal("100.00"),
    ]


def test_execution_summary_counts_rebate_income_and_bad_debt_expense(
    seeded_client, seeded_db, headers
):
    """库存详情：总收入含返点、总支出含坏账，净额与订单利润同口径。"""
    order_id = _order_with_events(seeded_db)
    _add_rebate(seeded_db, order_id, "100")
    _add_bad_debt(seeded_db, order_id, "400")

    response = seeded_client.get(
        f"/api/v1/orders/{order_id}/execution-detail", headers=headers
    )

    assert response.status_code == 200, response.text
    summary = response.json()["finance_summary"]
    assert Decimal(summary["total_income"]) == Decimal("1600.00")
    assert Decimal(summary["total_expense"]) == Decimal("1400.00")
    assert Decimal(summary["net_amount"]) == Decimal("200.00")


def test_profit_and_report_totals_share_same_cashflow_basis(seeded_db):
    """利润权威取数口与报表取数口数值同源（PROFIT-02 / REPORT-01 铁律）。

    ``order_cashflow_profit_by_order``（分润基数/订单列表）与
    ``cashflow_totals_by_order``（报表 R1-R5）是两条独立 SQL 聚合，但必须共用
    同一口径：收入 IN + 返点、支出 OUT + 坏账，押金损失重分类流水排除。
    本用例覆盖全部四类来源，锁定二者数值恒等，防止任一处口径漂移。
    """
    order_id = _order_with_events(seeded_db, buy="1000", sell="1500")
    _add_flow(seeded_db, order_id, "IN", "80")      # 额外流入
    _add_flow(seeded_db, order_id, "OUT", "30")     # 额外流出
    _add_rebate(seeded_db, order_id, "100")         # 返点收入
    _add_bad_debt(seeded_db, order_id, "50")        # 坏账支出

    profits = order_cashflow_profit_by_order(seeded_db, order_ids=[order_id])
    totals = cashflow_totals_by_order(seeded_db, order_ids=[order_id])

    by_order = totals[order_id]
    assert profits[order_id] == by_order[0] - by_order[1]
    # 独立核对金额（IN 1500+80 + 返点100；OUT 1000+30 + 坏账50）
    assert profits[order_id] == Decimal("600.00")
    assert by_order[0] == Decimal("1680.00")
    assert by_order[1] == Decimal("1080.00")
