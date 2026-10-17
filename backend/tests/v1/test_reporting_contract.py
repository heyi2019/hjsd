"""reporting 报表契约测试（RPT-01）：R1/R2/R3/R5 + 订单利润明细的日期过滤与全部分组循环。

与 test_m4.py::TestReports 的分工：m4 已覆盖无数据冒烟、账号 COST 不进运营费用、
未归集返点独立列、日报与池余额一致、利润合计自洽、R3 空数据钻取；本文件补
日期过滤边界（from/to 双向 continue）、SELL 收入、运营费用/返点结算循环、
提成分配、订单归属返点、订单明细事件分类与返点 join、?from=&to= API 路径。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest

from app.accounts import service as account_service
from app.core.errors import Validation
from app.core.money import to_money
from app.core.security import CurrentUser, build_access_token
from app.domain.enums import (
    AccountStatus,
    Direction,
    Nature,
    OrderStatus,
    RebateStatus,
)
from app.domain.trade import Account, Cashflow, RebateRecord
from app.finance import service as finance_service
from app.orders import service as order_service
from app.policy import service as policy_service
from app.parties import service as parties_service
from app.reporting import service as reporting_service


def test_reporting_read_routes_publish_typed_response_models(app):
    paths = app.openapi()["paths"]

    expected = {
        "/api/v1/reports/inventory-health": "InventoryHealthOut",
        "/api/v1/reports/monthly-pnl": "MonthlyPnlOut",
        "/api/v1/reports/commission": "CommissionOut",
        "/api/v1/reports/business-pnl": "BusinessPnlOut",
        "/api/v1/reports/finance-dimensions": "FinanceDimensionOut",
        "/api/v1/reports/daily-funds": "DailyFundsOut",
        "/api/v1/reports/order-profit": "OrderProfitOut",
    }
    for path, model_name in expected.items():
        schema = paths[path]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
        assert schema["$ref"].endswith(f"/{model_name}")


def test_finance_dimension_report_groups_fund_and_accounting_attributes(
    seeded_db, seeded_client, headers
):
    from app.finance.cashflows import approve_cashflow, create_cashflow
    from app.finance.pool_accounts import create_pool_account, get_pool

    pool = get_pool(seeded_db, "HJ_INVEST")
    account = create_pool_account(
        seeded_db,
        pool_id=pool.id,
        account_no="RPT-DIM-001",
        account_name="经营分析账户",
        account_type="BANK",
        ownership="OWNED",
        opening_balance=Decimal("0"),
        actor="pytest",
    )
    for direction, amount, attribute in (
        ("IN", "100.00", "SELF_REVENUE"),
        ("OUT", "40.00", "SELF_DIRECT_COST"),
    ):
        flow = create_cashflow(
            seeded_db,
            pool_id=pool.id,
            pool_account_id=account.id,
            occurred_on=date(2026, 10, 17),
            direction=direction,
            nature="BUSINESS_IN" if direction == "IN" else "BUSINESS_OUT",
            fund_nature="BUSINESS",
            accounting_attribute=attribute,
            category="OTHER",
            amount=Decimal(amount),
            actor="pytest",
            note="资金属性分析测试",
        )
        approve_cashflow(seeded_db, flow.id, actor="finance")

    report = reporting_service.finance_dimension_report(
        seeded_db, from_date=date(2026, 10, 17), to_date=date(2026, 10, 17)
    )
    assert len(report["items"]) == 2
    assert report["total_amount"] == Decimal("140.00")
    assert report["total_signed_amount"] == Decimal("60.00")
    assert {item["account_no"] for item in report["items"]} == {"RPT-DIM-001"}
    assert {item["accounting_attribute"] for item in report["items"]} == {
        "SELF_REVENUE", "SELF_DIRECT_COST"
    }

    response = seeded_client.get(
        "/api/v1/reports/finance-dimensions",
        params={"from": "2026-10-17", "to": "2026-10-17"},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["total_signed_amount"] == "60.00"

    exported = seeded_client.get(
        "/api/v1/reports/finance-dimensions/export.csv", headers=headers
    )
    assert exported.status_code == 200, exported.text
    assert "fund_nature" in exported.content.decode("utf-8-sig").splitlines()[0]

D = date(2026, 10, 4)        # 主测试日（与 m4 一致）
EARLY = date(2026, 9, 15)    # 月初侧样本（用于 from 过滤）
MID_GATE = date(2026, 10, 1)  # 月份闸门


def _order(seeded_db, *, trade_date: date = D, account_id: int | None = None):
    if account_id is None:
        account_id = account_service.create_account(
            seeded_db,
            game_account=f"report-{uuid4().hex[:12]}",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        ).id
    return order_service.create_order(
        seeded_db, order_type="HS", trade_date=trade_date, actor="pytest",
        account_id=account_id,
    )


def _cashflow(
    seeded_db,
    *,
    flow_no: str,
    occurred_on: date,
    nature: str,
    direction: str,
    amount: str,
    order_event_id: int | None = None,
) -> None:
    seeded_db.add(
        Cashflow(
            flow_no=flow_no,
            pool_id=1,
            occurred_on=occurred_on,
            nature=nature,
            category="OTHER",
            direction=direction,
            amount=to_money(amount),
            order_event_id=order_event_id,
            created_by="pytest",
            updated_by="pytest",
        )
    )


def _month_item(data: dict, month: str) -> dict:
    matched = [item for item in data["items"] if item["month"] == month]
    assert matched, f"月份 {month} 不在报表中: {[i['month'] for i in data['items']]}"
    return matched[0]


# --------------------------------------------------------------------- R1 库存
class TestR1Inventory:
    def test_inventory_health_includes_account_live_fields(self, seeded_db):
        account = account_service.create_account(
            seeded_db,
            game_account="report-live-field",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        )
        parties_service.create_field_definition(
            seeded_db,
            entity_type="account",
            field_key="marketing_note",
            label="营销备注",
            actor="pytest",
        )
        parties_service.set_extra_values(
            seeded_db,
            entity_type="account",
            entity_id=account.id,
            values=[("marketing_note", "重点账号")],
        )

        item = next(
            row
            for row in reporting_service.r1_inventory_health(seeded_db)["items"]
            if row["inventory_no"] == account.inventory_no
        )

        assert item["extra_values"] == {"marketing_note": "重点账号"}

    def test_pickup_accounts_are_excluded_from_inventory_health(self, seeded_db):
        pickup = Account(
            inventory_no="ACC-R1-PICKUP",
            business_mode="DISTRIBUTION",
            inventory_type="PICKUP",
            status=AccountStatus.IN_STOCK.value,
            buy_date=D,
            cost_amount=to_money("500.00"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(pickup)
        seeded_db.flush()

        data = reporting_service.r1_inventory_health(seeded_db)

        assert "ACC-R1-PICKUP" not in {item["inventory_no"] for item in data["items"]}

    def test_account_loop_extra_cost_and_expected_price(self, seeded_db):
        in_stock = Account(
                inventory_no="ACC-R1-1",
            business_mode="SELF",
            inventory_type="RECOVERY",
            status=AccountStatus.IN_STOCK.value,
            buy_date=D,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        sold = Account(
                inventory_no="ACC-R1-2",
            status=AccountStatus.SOLD.value,
            cost_amount=to_money("800.00"),
            created_by="pytest",
            updated_by="pytest",
        )
        no_buy_date = Account(
                inventory_no="ACC-R1-3",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("500.00"),
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add_all([in_stock, sold, no_buy_date])
        seeded_db.flush()

        order = _order(seeded_db, account_id=in_stock.id)
        # 买-卖-买周期：SELL 会把账号翻 SOLD，再 BUY 回 IN_STOCK，
        # 此时历史 SELL 事件仍计入 expected_price（覆盖 R1 账号循环的售价汇总）
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="pytest",
        )
        order_service.post_event(
            seeded_db, order.id, event_type="SELL", amount="1500.00",
            occurred_on=D, actor="pytest",
        )
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="800.00",
            occurred_on=D, actor="pytest",
        )

        data = reporting_service.r1_inventory_health(seeded_db)
        items = {item["inventory_no"]: item for item in data["items"]}

        # 非库存状态账号被 continue 排除
        assert "ACC-R1-2" not in items
        # 无 buy_date → holding_days None、无挂单 → business/owner None
        idle = items["ACC-R1-3"]
        assert idle["holding_days"] is None
        assert idle["business"] is None
        assert idle["owner_id"] is None
        # 在库账号：成本按 BUY 累加（0+1000+800=1800）；
        # order_cost（1800）− 账号成本（1800）= 0；expected_price = 历史 SELL 合计 1500
        held = items["ACC-R1-1"]
        assert held["business"] == "HS"
        assert held["buy_amount"] == 1800
        assert held["extra_cost"] == 0
        assert held["total_cost"] == 1800
        assert held["expected_price"] == 1500
        assert held["expected_profit"] == -300
        assert held["holding_days"] == (date.today() - D).days


# --------------------------------------------------------------------- R2 月度
class TestR2MonthlyPnl:
    def test_rejects_reversed_date_range(self, seeded_db):
        with pytest.raises(Validation, match="开始日期不能晚于结束日期"):
            reporting_service.r2_monthly_pnl(
                seeded_db,
                from_date=date(2026, 10, 31),
                to_date=date(2026, 10, 1),
            )

    def test_sell_revenue_and_event_date_filters(self, seeded_db):
        order = _order(seeded_db)
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="pytest",
        )
        order_service.post_event(
            seeded_db, order.id, event_type="COST", amount="200.00",
            occurred_on=EARLY, actor="pytest",
        )
        order_service.post_event(
            seeded_db, order.id, event_type="SELL", amount="1300.00",
            occurred_on=D, actor="pytest",
        )

        full = reporting_service.r2_monthly_pnl(seeded_db)
        oct_item = _month_item(full, "2026-10")
        assert oct_item["sales_income"] == 1300
        assert oct_item["account_direct_cost"] == 1000
        assert _month_item(full, "2026-09")["account_direct_cost"] == 200

        # from 过滤：9 月事件被 continue
        gated = reporting_service.r2_monthly_pnl(seeded_db, from_date=MID_GATE)
        assert [i["month"] for i in gated["items"]] == ["2026-10"]
        assert gated["total"]["sales_income"] == 1300
        assert gated["total"]["operating_profit"] == 300
        # to 过滤：10 月事件被 continue
        early_only = reporting_service.r2_monthly_pnl(
            seeded_db, to_date=date(2026, 9, 30)
        )
        assert [i["month"] for i in early_only["items"]] == ["2026-09"]

    def test_cancelled_sell_is_reversed_in_reports(self, seeded_db):
        order = _order(seeded_db)
        order_service.post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount="500.00",
            occurred_on=D,
            actor="pytest",
        )
        sell, _ = order_service.post_event(
            seeded_db,
            order.id,
            event_type="SELL",
            amount="800.00",
            occurred_on=D,
            actor="pytest",
        )
        order_service.post_event(
            seeded_db,
            order.id,
            event_type="CANCEL",
            amount="800.00",
            occurred_on=D,
            actor="pytest",
            offset_event_id=sell.id,
            reason="售出撤销",
        )

        monthly = reporting_service.r2_monthly_pnl(seeded_db)
        oct_item = _month_item(monthly, "2026-10")
        assert oct_item["sales_income"] == 0
        assert oct_item["account_direct_cost"] == 500

        detail = reporting_service.order_profit_detail(seeded_db)["items"][0]
        assert detail["income"] == 0
        assert detail["buy_amount"] == 500
        assert detail["net_profit"] == -500

    def test_operating_expense_and_rebate_net_loops(self, seeded_db):
        order = _order(seeded_db)
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="pytest",
        )
        # 运营费用：非订单来源的业务支出流水
        _cashflow(
            seeded_db, flow_no="CF-R2-1", occurred_on=D,
            nature=Nature.BUSINESS_OUT.value, direction=Direction.OUT.value,
            amount="500.00",
        )
        _cashflow(
            seeded_db, flow_no="CF-R2-2", occurred_on=EARLY,
            nature=Nature.BUSINESS_OUT.value, direction=Direction.OUT.value,
            amount="100.00",
        )
        # 返点结算：毛额 − 手续费 = 净额
        record = finance_service.create_rebate(
            seeded_db, source_order_id=order.id, base_amount="1000.00",
            rebate_type="BUY",
            collected_on=D, actor="pytest", rate="10",
        )
        finance_service.settle_rebate(
            seeded_db, record.id, gross_amount="100.00", settled_on=D, pool_id=2,
            actor="pytest", platform_fee="10.00",
        )

        full = reporting_service.r2_monthly_pnl(seeded_db)
        assert _month_item(full, "2026-10")["operating_expense"] == 510
        assert _month_item(full, "2026-10")["rebate_income"] == 100
        assert _month_item(full, "2026-09")["operating_expense"] == 100

        # from 过滤同时排除运营费用与返点结算
        gated = reporting_service.r2_monthly_pnl(seeded_db, from_date=date(2026, 10, 5))
        assert gated["items"] == []

        # to 过滤：10 月运营费用与结算日均被 continue，只剩 9 月运营费用
        early_only = reporting_service.r2_monthly_pnl(
            seeded_db, to_date=date(2026, 9, 30)
        )
        assert [i["month"] for i in early_only["items"]] == ["2026-09"]
        assert _month_item(early_only, "2026-09")["operating_expense"] == 100
        assert _month_item(early_only, "2026-09")["rebate_income"] == 0


# --------------------------------------------------------------------- R3 提成
class TestR3Commission:
    def test_allocations_drill_down_and_date_filters(self, seeded_db):
        order = _order(seeded_db)
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="seeduser1",
        )
        order_service.post_event(
            seeded_db, order.id, event_type="SELL", amount="1300.00",
            occurred_on=D, actor="seeduser1",
        )
        policy_service.set_allocations(
            seeded_db, order.id,
            items=[{"allocation_type": kind, "user_id": 7 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": 100 if kind == "OPERATION" else 0} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")],
            actor="pytest",
        )

        data = reporting_service.r3_commission_reconciliation(seeded_db)
        assert data["total"]["order_count"] == 4
        assert len(data["items"]) == 4
        assert any(item["user_id"] == 7 for item in data["items"])
        person = next(group for group in data["groups"] if group["user_id"] == 7)
        assert person["user_id"] == 7
        assert person["order_count"] == 1
        assert person["profit_base"] == 300
        assert person["orders"][0]["profit_base"] == 300
        assert person["orders"][0]["rate"] == 100

        # 已完成订单与进行中订单都属于有效提成对账范围。
        completed = _order(seeded_db)
        order_service.post_event(
            seeded_db, completed.id, event_type="BUY", amount="500.00",
            occurred_on=D, actor="seeduser1",
        )
        order_service.post_event(
            seeded_db, completed.id, event_type="SELL", amount="800.00",
            occurred_on=D, actor="seeduser1",
        )
        completed.status = OrderStatus.COMPLETED.value
        policy_service.set_allocations(
            seeded_db, completed.id,
            items=[{"allocation_type": kind, "user_id": 7 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": 100 if kind == "OPERATION" else 0} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")],
            actor="pytest",
        )

        data = reporting_service.r3_commission_reconciliation(seeded_db)
        person = next(group for group in data["groups"] if group["user_id"] == 7)
        assert person["order_count"] == 2
        assert {item["order_id"] for item in person["orders"]} == {
            order.id,
            completed.id,
        }

        # 日期过滤：交易日在区间外 → continue，无数据
        assert (
            reporting_service.r3_commission_reconciliation(
                seeded_db, to_date=date(2026, 10, 1)
            )["items"]
            == []
        )
        assert (
            reporting_service.r3_commission_reconciliation(
                seeded_db, from_date=date(2026, 10, 10)
            )["items"]
            == []
        )


# --------------------------------------------------------------------- R5 业务
class TestR5BusinessPnl:
    def test_rebate_settlement_outside_report_period_is_excluded(self, seeded_db):
        order = _order(seeded_db)
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="pytest",
        )
        record = finance_service.create_rebate(
            seeded_db,
            source_order_id=order.id,
            rebate_type="BUY",
            base_amount="1000.00",
            collected_on=D,
            actor="pytest",
            rate="10",
        )
        finance_service.settle_rebate(
            seeded_db,
            record.id,
            gross_amount="100.00",
            settled_on=date(2026, 9, 30),
            pool_id=2,
            actor="pytest",
            platform_fee="10.00",
        )
        seeded_db.commit()

        hs = next(
            row
            for row in reporting_service.r5_business_pnl(
                seeded_db,
                from_date=date(2026, 10, 1),
                to_date=date(2026, 10, 31),
            )["items"]
            if row["order_type"] == "HS"
        )
        assert hs["settled_rebate"] == 0
        assert hs["uncollected_rebate"] == 100

    def test_partial_rebate_settlement_keeps_uncollected_balance(self, seeded_db):
        order = _order(seeded_db)
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="pytest",
        )
        record = finance_service.create_rebate(
            seeded_db,
            source_order_id=order.id,
            rebate_type="BUY",
            base_amount="1000.00",
            collected_on=D,
            actor="pytest",
            rate="10",
        )
        finance_service.settle_rebate(
            seeded_db,
            record.id,
            gross_amount="60.00",
            settled_on=D,
            pool_id=2,
            actor="pytest",
        )
        seeded_db.commit()

        item = next(
            row
            for row in reporting_service.r5_business_pnl(seeded_db)["items"]
            if row["order_type"] == "HS"
        )
        assert item["settled_rebate"] == 60
        assert item["uncollected_rebate"] == 40

    def test_uncollected_and_settled_rebate_buckets(self, seeded_db):
        order = _order(seeded_db)
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="pytest",
        )
        order_service.post_event(
            seeded_db, order.id, event_type="SELL", amount="1300.00",
            occurred_on=D, actor="pytest",
        )
        # 已结算返点：毛额 100 − 手续费 10 = 90
        record = finance_service.create_rebate(
            seeded_db, source_order_id=order.id, base_amount="1000.00",
            rebate_type="BUY",
            collected_on=D, actor="pytest", rate="10",
        )
        finance_service.settle_rebate(
            seeded_db, record.id, gross_amount="100.00", settled_on=D, pool_id=2,
            actor="pytest", platform_fee="10.00",
        )
        # 未归集返点仍必须归属于具体订单。
        dg_order = order_service.create_order(
            seeded_db, order_type="DG", trade_date=D, actor="pytest"
        )
        seeded_db.add(
            RebateRecord(
                rebate_no="RB-R5-1",
                source_order_id=dg_order.id,
                rebate_type="SELL",
                rate=to_money("10"),
                base_amount=to_money("500.00"),
                status=RebateStatus.OPEN.value,
                collected_on=D,
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.commit()

        data = reporting_service.r5_business_pnl(seeded_db)
        by_type = {item["order_type"]: item for item in data["items"]}
        hs = by_type["HS"]
        assert hs["business_mode"] == "SELF"
        assert hs["business_type"] == "RECOVERY"
        assert hs["main_income"] == 1300
        assert hs["main_cost"] == 1010
        assert hs["main_profit"] == 290
        assert hs["settled_rebate"] == 100
        assert hs["uncollected_rebate"] == 0
        assert hs["full_income"] == 390
        # 未归集独立成桶，不摊给 HS
        uncollected = by_type["DG"]
        assert uncollected["uncollected_rebate"] == 50
        assert uncollected["main_profit"] == 0
        assert uncollected["full_income"] == 0

        # from 过滤同时作用于事件和返点结算日期
        gated = reporting_service.r5_business_pnl(seeded_db, from_date=date(2026, 10, 5))
        gated_by_type = {item["order_type"]: item for item in gated["items"]}
        assert gated_by_type["HS"]["main_income"] == 0
        assert gated_by_type["HS"]["main_profit"] == 0
        assert gated_by_type["HS"]["settled_rebate"] == 0
        assert gated_by_type["HS"]["uncollected_rebate"] == 100
        assert gated_by_type["DG"]["uncollected_rebate"] == 50

        # to 过滤：occurred_on 和 settled_on=D 的数据均在区间外
        gated_to = reporting_service.r5_business_pnl(seeded_db, to_date=date(2026, 10, 1))
        to_by_type = {item["order_type"]: item for item in gated_to["items"]}
        assert to_by_type["HS"]["main_income"] == 0
        assert to_by_type["HS"]["settled_rebate"] == 0
        assert to_by_type["HS"]["uncollected_rebate"] == 100
        assert to_by_type["DG"]["uncollected_rebate"] == 50


# --------------------------------------------------------------------- 订单利润明细
class TestOrderProfitDetail:
    def test_event_classification_rebate_join_and_date_filters(self, seeded_db):
        order = _order(seeded_db)
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="pytest",
        )
        order_service.post_event(
            seeded_db, order.id, event_type="COST", amount="200.00",
            occurred_on=D, actor="pytest",
        )
        order_service.post_event(
            seeded_db, order.id, event_type="SELL", amount="1300.00",
            occurred_on=D, actor="pytest",
        )
        record = finance_service.create_rebate(
            seeded_db, source_order_id=order.id, base_amount="1000.00",
            rebate_type="BUY",
            collected_on=D, actor="pytest", rate="10",
        )
        finance_service.settle_rebate(
            seeded_db, record.id, gross_amount="100.00", settled_on=D, pool_id=2,
            actor="pytest", platform_fee="10.00",
        )

        data = reporting_service.order_profit_detail(seeded_db)
        assert data["total"]["income"] == 1300
        assert data["total"]["buy_amount"] == 1000
        assert data["total"]["direct_cost"] == 210
        assert data["total"]["rebate"] == 100
        assert data["total"]["net_profit"] == 190
        item = data["items"][0]
        assert item["income"] == 1300
        assert item["buy_amount"] == 1000
        assert item["direct_cost"] == 210
        assert item["rebate"] == 100
        assert item["net_profit"] == 190

        # 交易日在区间外 → continue
        assert (
            reporting_service.order_profit_detail(
                seeded_db, from_date=date(2026, 10, 10)
            )["items"]
            == []
        )
        assert (
            reporting_service.order_profit_detail(
                seeded_db, to_date=date(2026, 10, 1)
            )["items"]
            == []
        )


# --------------------------------------------------------------------- API 日期参数
class TestReportsApiDateParams:
    def test_from_to_query_aliases(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        order_service.post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="pytest",
        )
        order_service.post_event(
            seeded_db, order.id, event_type="COST", amount="200.00",
            occurred_on=EARLY, actor="pytest",
        )
        order_service.post_event(
            seeded_db, order.id, event_type="SELL", amount="1300.00",
            occurred_on=D, actor="pytest",
        )

        pnl = seeded_client.get(
            "/api/v1/reports/monthly-pnl?from=2026-10-01&to=2026-10-31",
            headers=headers,
        )
        assert pnl.status_code == 200, pnl.text
        months = [item["month"] for item in pnl.json()["items"]]
        assert months == ["2026-10"]

        profit = seeded_client.get(
            "/api/v1/reports/order-profit?from=2026-10-01&to=2026-10-31",
            headers=headers,
        )
        assert profit.status_code == 200, profit.text
        assert [item["trade_date"] for item in profit.json()["items"]] == ["2026-10-04"]

    def test_reports_follow_owner_and_pool_scope(self, seeded_client, seeded_db):
        mine = _order(seeded_db)
        mine.owner_id = 9
        other = _order(seeded_db)
        other.owner_id = 8
        seeded_db.flush()
        for order, amount in ((mine, "100"), (other, "200")):
            order_service.post_event(
                seeded_db, order.id, event_type="BUY", amount=amount,
                occurred_on=D, actor="pytest",
            )

        operator = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        operator_headers = {"Authorization": f"Bearer {build_access_token(operator)}"}
        profit = seeded_client.get("/api/v1/reports/order-profit", headers=operator_headers)
        assert profit.status_code == 200, profit.text
        assert [row["order_no"] for row in profit.json()["items"]] == [mine.order_no]

        finance = CurrentUser.build(
            id=9,
            username="finance",
            roles=["FINANCE"],
            owner_scope="SELF",
            pool_ids=frozenset({1}),
        )
        finance_headers = {"Authorization": f"Bearer {build_access_token(finance)}"}
        funds = seeded_client.get("/api/v1/reports/daily-funds", headers=finance_headers)
        assert funds.status_code == 200, funds.text
        assert {row["pool_code"] for row in funds.json()["items"]} == {"HJ_INVEST"}

    def test_report_export_is_csv_and_viewer_cannot_export(
        self, seeded_client, headers, viewer_headers
    ):
        exported = seeded_client.get(
            "/api/v1/reports/order-profit/export.csv",
            params={"from": "2026-10-01", "to": "2026-10-31"},
            headers=headers,
        )
        assert exported.status_code == 200, exported.text
        assert exported.headers["content-type"].startswith("text/csv")
        assert "attachment" in exported.headers["content-disposition"]
        assert "row_type" in exported.content.decode("utf-8-sig").splitlines()[0]

        denied = seeded_client.get(
            "/api/v1/reports/order-profit/export.csv", headers=viewer_headers
        )
        assert denied.status_code == 403

    def test_order_profit_export_includes_order_extra_values(
        self, seeded_client, seeded_db, headers
    ):
        definition = parties_service.create_field_definition(
            seeded_db,
            entity_type="order",
            field_key="export_note",
            label="导出备注",
            actor="pytest",
        )
        order = _order(seeded_db)
        parties_service.set_extra_values(
            seeded_db,
            entity_type="order",
            entity_id=order.id,
            values=[(definition.field_key, "应导出")],
        )

        exported = seeded_client.get(
            "/api/v1/reports/order-profit/export.csv", headers=headers
        )
        assert exported.status_code == 200, exported.text
        csv_text = exported.content.decode("utf-8-sig")
        assert "extra_values" in csv_text.splitlines()[0]
        assert "应导出" in csv_text

    def test_scoped_business_pnl_hides_foreign_rebates(self, seeded_db):
        foreign_order = _order(seeded_db)
        foreign_order.owner_id = 8
        seeded_db.flush()
        seeded_db.add(
            RebateRecord(
                rebate_no="RB-R5-SCOPE",
                source_order_id=foreign_order.id,
                rebate_type="SELL",
                rate=to_money("10"),
                base_amount=to_money("500"),
                status=RebateStatus.OPEN.value,
                link_status="UNLINKED",
                collected_on=D,
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.flush()
        scoped = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )

        data = reporting_service.r5_business_pnl(seeded_db, user=scoped)
        assert all(row["order_type"] != foreign_order.order_type for row in data["items"])
