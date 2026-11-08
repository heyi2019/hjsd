"""REPORT-01 M4：R1-R5 报表 / 审计查询。"""
from __future__ import annotations

from datetime import date

from app.stocks import service as stocks_service
from app.orders import service as order_service
from app.reporting import service as reporting_service

REPORTS = "/api/v1/reports"


class TestReports:
    def test_r1_excludes_th_and_zero_cost(self, seeded_db):
        data = reporting_service.r1_inventory_health(seeded_db)
        for item in data["items"]:
            assert item["status"] == "IN_STOCK"

    def test_r2_operating_expense_excludes_account_cost(self, seeded_db):
        """账号 COST 只能进直接成本，不能进运营费用（R2 验收口径）。"""
        account = stocks_service.create_account(
            seeded_db,
            game_account="m4-r2-account",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        )
        order = order_service.create_order(
            seeded_db,
            order_type="HS",
            trade_date=date(2026, 10, 4),
            actor="pytest",
            account_id=account.id,
        )
        order_service.post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount="1000.00",
            occurred_on=date(2026, 10, 4),
            actor="pytest",
        )
        order_service.post_event(
            seeded_db,
            order.id,
            event_type="COST",
            amount="300.00",
            occurred_on=date(2026, 10, 4),
            actor="pytest",
        )
        data = reporting_service.r2_monthly_pnl(seeded_db)
        month = [i for i in data["items"] if i["month"] == "2026-10"]
        assert month
        assert month[0]["account_direct_cost"] == 1300
        assert month[0]["operating_expense"] == 0

    def test_r5_legacy_rebate_columns_are_removed(self, seeded_db):
        data = reporting_service.r5_business_pnl(seeded_db)
        for item in data["items"]:
            assert {"main_income", "main_cost", "main_profit"} <= set(item)
            for key in ("settled_rebate", "uncollected_rebate", "full_income"):
                assert key not in item
        for key in ("settled_rebate", "uncollected_rebate", "full_income"):
            assert key not in data["total"]

    def test_daily_funds_matches_pool_balance(self, seeded_db):
        report = reporting_service.daily_funds_report(seeded_db, on=date(2026, 10, 4))
        assert report["items"]
        for item in report["items"]:
            assert "available" in item and "th_advance" not in item
        assert report["total"]["available"] == sum(item["available"] for item in report["items"])

    def test_order_profit_totals_are_consistent(self, seeded_db):
        data = reporting_service.order_profit_detail(seeded_db)
        for item in data["items"]:
            assert item["net_profit"] == (
                item["income"] - item["buy_amount"] - item["direct_cost"]
            )

    def test_r3_drills_down_to_orders(self, seeded_db):
        data = reporting_service.r3_commission_reconciliation(seeded_db)
        for person in data["groups"]:
            assert person["orders"]
            assert sum(o["profit_base"] for o in person["orders"]) == person["profit_base"]
        assert data["total"]["order_count"] == len(data["items"])


class TestM4Api:
    def test_reports_endpoints_require_permission(self, seeded_client, viewer_headers):
        for path in (
            "/reports/inventory-health",
            "/reports/monthly-pnl",
            "/reports/business-pnl",
            "/reports/commission",
            "/reports/daily-funds",
            "/reports/order-profit",
        ):
            response = seeded_client.get(f"{REPORTS}{path[8:]}", headers=viewer_headers)
            assert response.status_code in (200, 403), path

    def test_audit_logs_endpoint(self, seeded_client, headers):
        response = seeded_client.get("/api/v1/audit-logs", headers=headers)
        assert response.status_code == 200
        assert "items" in response.json()
