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
from sqlalchemy import select

from app.stocks import service as account_service
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
from app.domain.foundation import Pool
from app.domain.trade import Account, Cashflow, RebateRecord
from app.finance import service as finance_service
from app.orders import service as order_service
from app.policy import service as policy_service
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

    # 资金池账户已下线：直接在种子池上造流水（等价于原 get_pool + create_pool_account）
    pool = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
    assert pool is not None, "种子池 HJ_INVEST 缺失"
    for direction, amount, attribute in (
        ("IN", "100.00", "SELF_REVENUE"),
        ("OUT", "40.00", "SELF_DIRECT_COST"),
    ):
        flow = create_cashflow(
            seeded_db,
            pool_id=pool.id,
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
    assert {item["pool_code"] for item in report["items"]} == {"HJ_INVEST"}
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
    # 2026-10-29 起导出表头用「列表字段」里的中文列名，不再是英文键
    assert "资金性质" in exported.content.decode("utf-8-sig").splitlines()[0]

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
    def test_inventory_health_api_accepts_missing_platform_and_returns_total_cost(
        self, seeded_db, seeded_client, headers
    ):
        account = Account(
            game_account="report-null-platform",
            inventory_type="RECOVERY",
            status=AccountStatus.IN_STOCK.value,
            cost_amount=to_money("125.00"),
            platform=None,
            created_by="pytest",
            updated_by="pytest",
        )
        seeded_db.add(account)
        seeded_db.flush()

        response = seeded_client.get("/api/v1/reports/inventory-health", headers=headers)

        assert response.status_code == 200, response.text
        payload = response.json()
        row = next(item for item in payload["items"] if item["account_id"] == account.id)
        assert row["platform"] is None
        assert payload["total_cost"] == "125.00"

    def test_pickup_accounts_are_excluded_from_inventory_health(self, seeded_db):
        pickup = Account(
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

        assert pickup.id not in {item["account_id"] for item in data["items"]}

    def test_account_loop_extra_cost_and_expected_price(self, seeded_db):
        in_stock = Account(
            business_mode="SELF",
            inventory_type="RECOVERY",
            status=AccountStatus.IN_STOCK.value,
            buy_date=D,
            cost_amount=to_money("0"),
            created_by="pytest",
            updated_by="pytest",
        )
        sold = Account(
            status=AccountStatus.SOLD.value,
            cost_amount=to_money("800.00"),
            created_by="pytest",
            updated_by="pytest",
        )
        no_buy_date = Account(
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
        items = {item["account_id"]: item for item in data["items"]}

        # 非库存状态账号被 continue 排除
        assert sold.id not in items
        # 无 buy_date → holding_days None、无挂单 → business/owner None
        idle = items[no_buy_date.id]
        assert idle["holding_days"] is None
        assert idle["business"] is None
        assert idle["owner_id"] is None
        # 在库账号：成本按 BUY 累加（0+1000+800=1800）；
        # order_cost（1800）− 账号成本（1800）= 0；expected_price = 历史 SELL 合计 1500
        held = items[in_stock.id]
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
# --------------------------------------------------------------------- 订单利润明细
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
        header = exported.content.decode("utf-8-sig").splitlines()[0].split(",")
        assert header[0] == "row_type"
        # 2026-10-29 起表头用「列表字段」的中文列名：已登记列不再出现英文键。
        # 该用例的时间窗内无订单明细，表头由合计行字段构成，故只断言中文口径。
        assert "收入" in header
        assert "income" not in header

        denied = seeded_client.get(
            "/api/v1/reports/order-profit/export.csv", headers=viewer_headers
        )
        assert denied.status_code == 403

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
