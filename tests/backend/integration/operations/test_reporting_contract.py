"""REPORT-01 报表功能契约：R2/R3/R5 与订单利润口径。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.business.inventory.profile import create_account
from app.core.errors import Validation
from app.core.money import to_money
from app.core.security import CurrentUser, build_access_token
from app.domain.enums import (
    OrderStatus,
)
from app.domain.foundation import Pool
from app.domain.trade import Account, RebateRecord
from app.domain.users import User
from app.funds.cashflows import create_cashflow
from app.business.orders.create import create_order
from app.business.events import post_event
from app.funds.profit_allocation import service as policy_allocations
from app.operations.profit import order_profit_detail
from app.operations.r2_monthly_pnl import r2_monthly_pnl
from app.operations.r3_commission import r3_commission_reconciliation
from app.operations.r5_business_pnl import r5_business_pnl


def test_report_viewer_can_read_employee_options_for_operations_filter(
    seeded_client, viewer_headers
):
    response = seeded_client.get("/api/users/options", headers=viewer_headers)
    assert response.status_code == 200, response.text
    assert all(item["is_active"] for item in response.json())
    report = seeded_client.get(
        "/api/reports/commission",
        params={"all_people": "true"},
        headers=viewer_headers,
    )
    assert report.status_code == 200, report.text


D = date(2026, 10, 4)        # 主测试日（与 m4 一致）
EARLY = date(2026, 9, 15)    # 月初侧样本（用于 from 过滤）
MID_GATE = date(2026, 10, 1)  # 月份闸门


def _order(seeded_db, *, trade_date: date = D, account_id: int | None = None):
    if account_id is None:
        account_id = create_account(
            seeded_db,
            game_account=f"report-{uuid4().hex[:12]}",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        ).id
    return create_order(
        seeded_db, order_type="HS", trade_date=trade_date, actor="pytest",
        account_id=account_id,
    )


def _month_item(data: dict, month: str) -> dict:
    matched = [item for item in data["items"] if item["month"] == month]
    assert matched, f"月份 {month} 不在报表中: {[i['month'] for i in data['items']]}"
    return matched[0]


def _commission_details(data: dict) -> list[dict]:
    return [
        detail
        for order in data["order_groups"]
        for detail in order["orders"]
    ]


def _direct_cost(seeded_db, order_id: int, amount: str, occurred_on: date) -> None:
    pool = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
    assert pool is not None
    create_cashflow(
        seeded_db,
        pool_id=pool.id,
        occurred_on=occurred_on,
        direction="OUT",
        accounting_attribute="SELF_DIRECT_COST",
        category="OTHER",
        amount=Decimal(amount),
        actor="pytest",
        order_id=order_id,
        note="订单直接支出",
    )


# --------------------------------------------------------------------- R2 月度
class TestR2MonthlyPnl:
    def test_rejects_reversed_date_range(self, seeded_db):
        with pytest.raises(Validation, match="开始日期不能晚于结束日期"):
            r2_monthly_pnl(
                seeded_db,
                from_date=date(2026, 10, 31),
                to_date=date(2026, 10, 1),
            )

    def test_sell_revenue_and_event_date_filters(self, seeded_db):
        order = _order(seeded_db)
        post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="pytest",
        )
        _direct_cost(seeded_db, order.id, "200.00", EARLY)
        post_event(
            seeded_db, order.id, event_type="SELL", amount="1300.00",
            occurred_on=D, actor="pytest",
        )

        full = r2_monthly_pnl(seeded_db)
        oct_item = _month_item(full, "2026-10")
        assert oct_item["sales_income"] == 1300
        assert oct_item["cost"] == 1000
        assert _month_item(full, "2026-09")["cost"] == 200

        # from 过滤：9 月事件被 continue
        gated = r2_monthly_pnl(seeded_db, from_date=MID_GATE)
        assert [i["month"] for i in gated["items"]] == ["2026-10"]
        assert gated["total"]["sales_income"] == 1300
        assert gated["total"]["operating_profit"] == 300
        # to 过滤：10 月事件被 continue
        early_only = r2_monthly_pnl(
            seeded_db, to_date=date(2026, 9, 30)
        )
        assert [i["month"] for i in early_only["items"]] == ["2026-09"]

    def test_cancelled_sell_is_reversed_in_reports(self, seeded_db):
        order = _order(seeded_db)
        post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount="500.00",
            occurred_on=D,
            actor="pytest",
        )
        sell, _ = post_event(
            seeded_db,
            order.id,
            event_type="SELL",
            amount="800.00",
            occurred_on=D,
            actor="pytest",
        )
        post_event(
            seeded_db,
            order.id,
            event_type="CANCEL",
            amount="800.00",
            occurred_on=D,
            actor="pytest",
            offset_event_id=sell.id,
            reason="售出撤销",
        )

        monthly = r2_monthly_pnl(seeded_db)
        oct_item = _month_item(monthly, "2026-10")
        # 资金明细口径（11-05 裁决）：撤销售出产生一笔反向资金流水，
        # 收入列仍是已入账的 800，冲销的 800 计入支出；净利仍为 -500。
        assert oct_item["sales_income"] == 800
        assert oct_item["cost"] == 1300
        assert oct_item["operating_profit"] == -500

        detail = order_profit_detail(seeded_db)["items"][0]
        assert detail["income"] == 800
        assert detail["cost"] == 1300
        assert detail["net_profit"] == -500


def test_order_profit_scopes_downstream_reads_to_requested_trade_dates(seeded_db, monkeypatch):
    in_range = _order(seeded_db, trade_date=D)
    _order(seeded_db, trade_date=EARLY)
    captured_order_ids: list[list[int]] = []

    def capture_cashflow_order_ids(session, *, order_ids=None, from_date=None, to_date=None):
        captured_order_ids.append(list(order_ids or []))
        return {}

    monkeypatch.setattr(
        "app.operations.profit.cashflow_totals_by_order",
        capture_cashflow_order_ids,
    )

    report = order_profit_detail(seeded_db, from_date=MID_GATE)

    assert [item["order_id"] for item in report["items"]] == [in_range.id]
    assert captured_order_ids == [[in_range.id]]


# --------------------------------------------------------------------- R3 提成
class TestR3Commission:
    def test_personal_commission_total_reuses_rounding_without_detail_queries(self, seeded_db):
        from sqlalchemy import event
        from app.workbench.overview.service import workbench_summary

        for sale in ("100.01", "90.00"):
            order = _order(seeded_db)
            post_event(seeded_db, order.id, event_type="BUY", amount="100.00", occurred_on=D, actor="pytest")
            post_event(seeded_db, order.id, event_type="SELL", amount=sale, occurred_on=D, actor="pytest")
            policy_allocations.set_allocations(seeded_db, order.id, items=[
                {"user_id": 7, "role": "OWNER", "allocation_rate": 50},
                {"user_id": 8, "role": "OWNER", "allocation_rate": 50},
            ], actor="pytest")

        user = CurrentUser.build(id=7, username="seeduser7", roles=["OPERATOR"], owner_scope="SELF")
        report = r3_commission_reconciliation(seeded_db, user=user, mine=True, from_date=MID_GATE, to_date=D)
        statements = []
        connection = seeded_db.connection()

        def record(_connection, _cursor, statement, _params, _context, _executemany):
            if statement.lstrip().upper().startswith("SELECT"):
                statements.append(" ".join(statement.lower().split()))

        event.listen(connection, "before_cursor_execute", record)
        try:
            summary = workbench_summary(seeded_db, user=user, from_date=MID_GATE, to_date=D)
        finally:
            event.remove(connection, "before_cursor_execute", record)
        assert summary["personal_earnings"] == report["total"]["profit_base"] == Decimal("-2.49")
        assert not any("from accounts where accounts.id in" in sql for sql in statements)
        assert not any("select order_events.order_id, order_events.occurred_on" in sql for sql in statements)

    def test_commission_limits_profit_calculation_to_order_date_range(self, seeded_db, monkeypatch):
        import app.operations.r3_commission as commission_service

        orders = []
        for trade_day in (EARLY, D, date(2026, 11, 4)):
            order = _order(seeded_db, trade_date=trade_day)
            post_event(seeded_db, order.id, event_type="BUY", amount="1000.00", occurred_on=trade_day, actor="pytest")
            post_event(seeded_db, order.id, event_type="SELL", amount="1300.00", occurred_on=trade_day, actor="pytest")
            policy_allocations.set_allocations(seeded_db, order.id, items=[
                {"user_id": 7, "role": "OWNER", "allocation_rate": 50},
                {"user_id": 8, "role": "OWNER", "allocation_rate": 50},
            ], actor="pytest")
            orders.append(order)

        user = CurrentUser.build(id=7, username="seeduser7", roles=["OPERATOR"], owner_scope="SELF")
        calculate = commission_service.cashflow_totals_by_order
        calculated_ids = []

        def track_calculation(session, *, order_ids):
            calculated_ids.append(set(order_ids))
            return calculate(session, order_ids=order_ids)

        monkeypatch.setattr(commission_service, "cashflow_totals_by_order", track_calculation)
        result = r3_commission_reconciliation(seeded_db, user=user, mine=True, from_date=MID_GATE, to_date=D)
        assert calculated_ids == [{orders[1].id}]
        assert result["total"] == {"order_count": 1, "profit_base": Decimal("90.00")}
        assert {item["user_id"] for item in _commission_details(result)} == {7}

        calculated_ids.clear()
        all_time = r3_commission_reconciliation(seeded_db, user=user, mine=True)
        assert calculated_ids == [{order.id for order in orders}]
        assert all_time["total"] == {"order_count": 3, "profit_base": Decimal("270.00")}

    def test_my_commission_only_returns_the_logged_in_users_allocations(self, seeded_db):
        order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=date.today(),
            actor="seeduser7",
            owner_id=8,
            account_snapshot={"game_account": "my-commission-account"},
        )
        post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="seeduser7",
        )
        post_event(
            seeded_db, order.id, event_type="SELL", amount="1300.00",
            occurred_on=D, actor="seeduser7",
        )
        policy_allocations.set_allocations(
            seeded_db,
            order.id,
            items=[
                {"user_id": 7, "role": "OWNER", "allocation_rate": 50},
                {"user_id": 8, "role": "OWNER", "allocation_rate": 50},
            ],
            actor="pytest",
        )

        user = CurrentUser.build(
            id=7,
            username="seeduser7",
            roles=["OPERATOR"],
            owner_scope="SELF",
            display_name="种子用户7",
        )
        data = r3_commission_reconciliation(
            seeded_db, user=user, mine=True
        )

        assert {item["user_id"] for item in _commission_details(data)} == {7}
        assert data["total"]["order_count"] == 1
        assert data["total"]["profit_base"] == Decimal("90.00")
        assert r3_commission_reconciliation(seeded_db, user=user)["total"]["order_count"] == 0
        assert r3_commission_reconciliation(seeded_db, user=user, mine=True, user_id=8)["total"]["order_count"] == 0
        from app.workbench.overview.service import workbench_summary
        assert workbench_summary(seeded_db, user=user)["personal_earnings"] == Decimal("90.00")

    def test_all_people_commission_can_be_filtered_back_to_one_person(self, seeded_db, seeded_client, headers):
        order = _order(seeded_db)
        post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="seeduser1",
        )
        post_event(
            seeded_db, order.id, event_type="SELL", amount="1300.00",
            occurred_on=D, actor="seeduser1",
        )
        policy_allocations.set_allocations(
            seeded_db,
            order.id,
            items=[
                {"user_id": 7, "role": "OWNER", "allocation_rate": 50},
                {"user_id": 8, "role": "OWNER", "allocation_rate": 50},
            ],
            actor="pytest",
        )
        former_employee = seeded_db.get(User, 7)
        assert former_employee is not None
        former_employee.display_name = "离职同事"
        former_employee.is_active = False
        seeded_db.flush()
        scoped_user = CurrentUser.build(
            id=7, username="seeduser7", roles=["VIEWER"], owner_scope="SELF"
        )

        all_people = r3_commission_reconciliation(
            seeded_db, user=scoped_user, all_people=True
        )
        assert {item["user_id"] for item in _commission_details(all_people)} == {7, 8, None}
        assert next(item for item in _commission_details(all_people) if item["user_id"] == 7)["user_name"] == "离职同事"
        assert next(person for person in all_people["people"] if person["user_id"] == 7) == {
            "user_id": 7, "user_name": "离职同事", "is_active": False,
        }

        one_person = r3_commission_reconciliation(
            seeded_db, user=scoped_user, all_people=True, user_id=8
        )
        assert {item["user_id"] for item in _commission_details(one_person)} == {8}
        assert {person["user_id"] for person in one_person["people"]} == {7, 8}

        personal = r3_commission_reconciliation(seeded_db, user=scoped_user, mine=True)
        assert {person["user_id"] for person in personal["people"]} == {7}
        response = seeded_client.get("/api/reports/commission", params={"all_people": "true", "user_id": 7}, headers=headers)
        assert response.status_code == 200, response.text
        assert _commission_details(response.json())[0]["user_name"] == "离职同事"
        assert {person["user_id"] for person in response.json()["people"]} == {7, 8}
        options = seeded_client.get("/api/users/options", headers=headers)
        assert options.status_code == 200
        assert 7 not in {person["id"] for person in options.json()}

    def test_allocations_drill_down_and_date_filters(self, seeded_db):
        order = _order(seeded_db)
        post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="seeduser1",
        )
        post_event(
            seeded_db, order.id, event_type="SELL", amount="1300.00",
            occurred_on=D, actor="seeduser1",
        )
        policy_allocations.set_allocations(
            seeded_db, order.id,
            items=[{"allocation_type": kind, "user_id": 7 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": 100 if kind == "OPERATION" else 0} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")],
            actor="pytest",
        )

        data = r3_commission_reconciliation(seeded_db)
        assert data["total"]["order_count"] == 1
        assert len(data["order_groups"]) == 1
        assert data["order_groups"][0]["order_no"] == order.order_no
        assert len(data["order_groups"][0]["orders"]) == 4
        assert all(item["user_name"] == "公司" for item in _commission_details(data) if item["user_id"] is None)
        account = seeded_db.get(Account, order.account_id)
        assert account is not None
        account.inventory_entry_at = datetime(2026, 10, 2, 9, 30)
        seeded_db.flush()
        data = r3_commission_reconciliation(seeded_db)
        assert data["order_groups"][0]["inventory_date"] == date(2026, 10, 2)
        assert data["order_groups"][0]["outbound_date"] == D
        person = next(item for item in _commission_details(data) if item["user_id"] == 7)
        assert person["profit_base"] == 180
        assert person["rate"] == 60

        # 已完成订单与进行中订单都属于有效提成对账范围。
        completed = _order(seeded_db)
        post_event(
            seeded_db, completed.id, event_type="BUY", amount="500.00",
            occurred_on=D, actor="seeduser1",
        )
        post_event(
            seeded_db, completed.id, event_type="SELL", amount="800.00",
            occurred_on=D, actor="seeduser1",
        )
        completed.status = OrderStatus.COMPLETED.value
        policy_allocations.set_allocations(
            seeded_db, completed.id,
            items=[{"allocation_type": kind, "user_id": 7 if kind == "OPERATION" else None, "role": "OWNER", "allocation_rate": 100 if kind == "OPERATION" else 0} for kind in ("BUY", "SELL", "OPERATION", "COMPANY")],
            actor="pytest",
        )

        data = r3_commission_reconciliation(seeded_db)
        person_orders = [item for item in _commission_details(data) if item["user_id"] == 7]
        assert len(person_orders) == 2
        assert {item["order_id"] for item in person_orders} == {
            order.id,
            completed.id,
        }

        # 日期过滤：交易日在区间外 → continue，无数据
        assert (
            r3_commission_reconciliation(
                seeded_db, to_date=date(2026, 10, 1)
            )["order_groups"]
            == []
        )
        assert (
            r3_commission_reconciliation(
                seeded_db, from_date=date(2026, 10, 10)
            )["order_groups"]
            == []
        )

    def test_commission_export_honors_mine_and_user_id(self, seeded_db, seeded_client, headers):
        """R3 导出必须跟随页面的「我的收益/指定员工」，不能恒定默认全员口径。"""
        import csv
        import io

        order = _order(seeded_db)
        post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="pytest",
        )
        post_event(
            seeded_db, order.id, event_type="SELL", amount="1300.00",
            occurred_on=D, actor="pytest",
        )
        policy_allocations.set_allocations(
            seeded_db, order.id,
            items=[
                {"user_id": 7, "role": "OWNER", "allocation_rate": 50},
                {"user_id": 8, "role": "OWNER", "allocation_rate": 50},
            ],
            actor="pytest",
        )

        def exported_user_ids(query: dict, auth: dict) -> set[int]:
            response = seeded_client.get(
                "/api/reports/commission/export.csv", params=query, headers=auth
            )
            assert response.status_code == 200, response.text
            rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
            person_index = rows[0].index("人员 ID")
            return {int(row[person_index]) for row in rows[1:] if row[0] == "明细" and row[person_index]}

        assert exported_user_ids({"all_people": "true"}, headers) == {7, 8}
        # 指定员工：修复前 user_id 被导出接口忽略，仍导出两人。
        assert exported_user_ids({"all_people": "true", "user_id": "8"}, headers) == {8}

        mine_user = CurrentUser.build(
            id=7, username="seeduser7", roles=["ADMIN"], display_name="种子用户7"
        )
        mine_headers = {"Authorization": f"Bearer {build_access_token(mine_user)}"}
        # 我的收益：修复前 mine 被导出接口忽略，仍导出两人。
        assert exported_user_ids({"mine": "true"}, mine_headers) == {7}

        former_employee = seeded_db.get(User, 7)
        assert former_employee is not None
        former_employee.display_name = "离职同事"
        former_employee.is_active = False
        seeded_db.flush()
        response = seeded_client.get(
            "/api/reports/commission/export.csv", params={"all_people": "true", "user_id": 7}, headers=headers,
        )
        assert response.status_code == 200, response.text
        rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
        name_index = rows[0].index("分润人员")
        assert [row[name_index] for row in rows[1:] if row[0] == "明细"] == ["离职同事"]


# --------------------------------------------------------------------- R5 业务
# --------------------------------------------------------------------- 订单利润明细
# --------------------------------------------------------------------- API 日期参数
class TestReportsApiDateParams:
    def test_from_to_query_aliases(self, seeded_client, seeded_db, headers):
        order = _order(seeded_db)
        post_event(
            seeded_db, order.id, event_type="BUY", amount="1000.00",
            occurred_on=D, actor="pytest",
        )
        _direct_cost(seeded_db, order.id, "200.00", EARLY)
        post_event(
            seeded_db, order.id, event_type="SELL", amount="1300.00",
            occurred_on=D, actor="pytest",
        )

        pnl = seeded_client.get(
            "/api/reports/monthly-pnl?from=2026-10-01&to=2026-10-31",
            headers=headers,
        )
        assert pnl.status_code == 200, pnl.text
        months = [item["month"] for item in pnl.json()["items"]]
        assert months == ["2026-10"]

        profit = seeded_client.get(
            "/api/reports/order-profit?from=2026-10-01&to=2026-10-31",
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
            post_event(
                seeded_db, order.id, event_type="BUY", amount=amount,
                occurred_on=D, actor="pytest",
            )

        operator = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )
        operator_headers = {"Authorization": f"Bearer {build_access_token(operator)}"}
        profit = seeded_client.get("/api/reports/order-profit", headers=operator_headers)
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
        funds = seeded_client.get("/api/reports/daily-funds", headers=finance_headers)
        assert funds.status_code == 404

    def test_report_export_is_csv_and_viewer_cannot_export(
        self, seeded_client, headers, viewer_headers
    ):
        exported = seeded_client.get(
            "/api/reports/order-profit/export.csv",
            params={"from": "2026-10-01", "to": "2026-10-31"},
            headers=headers,
        )
        assert exported.status_code == 200, exported.text
        assert exported.headers["content-type"].startswith("text/csv")
        assert "attachment" in exported.headers["content-disposition"]
        header = exported.content.decode("utf-8-sig").splitlines()[0].split(",")
        assert header[0] == "行类型"
        # 2026-10-29 起表头用「列表字段」的中文列名：已登记列不再出现英文键。
        # 该用例的时间窗内无订单明细，表头由合计行字段构成，故只断言中文口径。
        assert "收入" in header
        assert "income" not in header

        denied = seeded_client.get(
            "/api/reports/order-profit/export.csv", headers=viewer_headers
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
                amount=to_money("500"),
                collected_on=D,
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.flush()
        scoped = CurrentUser.build(
            id=9, username="operator", roles=["OPERATOR"], owner_scope="SELF"
        )

        data = r5_business_pnl(seeded_db, user=scoped)
        assert all(row["order_type"] != foreign_order.order_type for row in data["items"])


class TestReports:
    def test_r2_operating_expense_excludes_account_direct_cashflow(self, seeded_db):
        """账号直接支出资金明细进入直接成本，不进入运营费用（R2 验收口径）。"""
        from datetime import date

        account = create_account(
            seeded_db,
            game_account="m4-r2-account",
            business_mode="SELF",
            inventory_type="RECOVERY",
            actor="pytest",
        )
        order = create_order(
            seeded_db,
            order_type="HS",
            trade_date=date(2026, 10, 4),
            actor="pytest",
            account_id=account.id,
        )
        post_event(
            seeded_db,
            order.id,
            event_type="BUY",
            amount="1000.00",
            occurred_on=date(2026, 10, 4),
            actor="pytest",
        )
        pool = seeded_db.scalar(select(Pool).where(Pool.code == "HJ_INVEST"))
        create_cashflow(
            seeded_db,
            pool_id=pool.id,
            occurred_on=date(2026, 10, 4),
            direction="OUT",
            accounting_attribute="SELF_DIRECT_COST",
            category="OTHER",
            amount=Decimal("300.00"),
            actor="pytest",
            order_id=order.id,
            note="账号直接支出",
        )
        data = r2_monthly_pnl(seeded_db)
        month = [i for i in data["items"] if i["month"] == "2026-10"]
        assert month
        assert month[0]["cost"] == 1300
        assert month[0]["operating_expense"] == 0

    def test_r5_legacy_rebate_columns_are_removed(self, seeded_db):
        """11-05 二次裁决：结算展示列下线，返点金额全站只认 amount。"""
        data = r5_business_pnl(seeded_db)
        for item in data["items"]:
            assert {"main_income", "cost", "main_profit"} <= set(item)
            for key in ("settled_rebate", "uncollected_rebate", "full_income"):
                assert key not in item
        for key in ("settled_rebate", "uncollected_rebate", "full_income"):
            assert key not in data["total"]

    def test_order_profit_totals_are_consistent(self, seeded_db):
        data = order_profit_detail(seeded_db)
        for item in data["items"]:
            # 净利 = 资金明细所有收入 − 所有支出（11-05 裁决）；
            # 返点独立成列、不进净利。
            assert item["net_profit"] == (
                item["income"] - item["cost"]
            )

    def test_r3_drills_down_to_orders(self, seeded_db):
        data = r3_commission_reconciliation(seeded_db)
        assert set(data["total"]) == {"order_count", "profit_base"}
        for order in data["order_groups"]:
            assert order["orders"]
            assert sum(o["profit_base"] for o in order["orders"]) == order["profit_base"]
        assert data["total"]["order_count"] == len(data["order_groups"])


# ----------------------------------------------------- 覆盖补口：池作用域与日期窗口
from app.funds import rebates  # noqa: E402
from app.operations.export import report_for_export  # noqa: E402
from app.operations.router import business_pnl  # noqa: E402


def _pool1_user(seeded_db) -> CurrentUser:
    """真实 User 行 + 仅授权池 1 的 CurrentUser（orders.owner_id 有 FK 约束）。"""
    from app.core.tokens import hash_password
    from app.domain.users import User

    row = User(
        username=f"r2scope-{uuid4().hex[:8]}",
        display_name="R2 Scope",
        password_hash=hash_password("scope-pass-123"),
        role="OPERATOR",
        owner_scope="SELF",
        pool_ids=[1],
        team_ids=[],
        is_active=True,
    )
    seeded_db.add(row)
    seeded_db.flush()
    return CurrentUser(
        id=row.id,
        username=row.username,
        roles=(),
        permissions=frozenset(),
        pool_ids=frozenset({1}),
        owner_scope="SELF",
    )


def test_r2_pool_scope_and_date_window_filters(seeded_db):
    """池作用域用户：返点/运营费只认授权池，且发生日窗口外的行被跳过。"""
    user = _pool1_user(seeded_db)
    account_id = create_account(
        seeded_db,
        game_account=f"r2-scope-{uuid4().hex[:8]}",
        business_mode="SELF",
        inventory_type="RECOVERY",
        actor="pytest",
    ).id
    order = create_order(
        seeded_db, order_type="HS", trade_date=D, actor="pytest",
        account_id=account_id,
    )
    order.owner_id = user.id
    seeded_db.flush()
    late = date(2026, 11, 20)
    # 窗口 [2026-10-01, 2026-10-31] 两侧各一笔返点：早于 from / 晚于 to
    rebates.create_rebate(
        seeded_db, source_order_id=order.id, rebate_type="BUY",
        amount=Decimal("30"), collected_on=EARLY, actor="pytest",
    )
    rebates.create_rebate(
        seeded_db, source_order_id=order.id, rebate_type="BUY",
        amount=Decimal("40"), collected_on=late, actor="pytest",
    )
    # 运营费用：池1窗口内 + 池2（无授权） + 池1窗口外两侧
    for occurred_on, pool_id, amount in (
        (D, 1, Decimal("10")),
        (D, 2, Decimal("99")),
        (EARLY, 1, Decimal("5")),
        (late, 1, Decimal("7")),
    ):
        create_cashflow(
            seeded_db, pool_id=pool_id, occurred_on=occurred_on,
            direction="OUT", accounting_attribute="OPERATING_EXPENSE", category="OFFICE",
            amount=amount, actor="pytest",
        )
    data = r2_monthly_pnl(
        seeded_db, from_date=date(2026, 10, 1), to_date=date(2026, 10, 31),
        user=user,
    )
    oct_item = _month_item(data, "2026-10")
    assert oct_item["operating_expense"] == Decimal("10")
    # 窗口外返点不进「其中返点」：仅窗口内（无）→ 2026-10 该列为 0
    assert oct_item["rebate_income"] == Decimal("0")


def test_report_for_export_monthly_pnl_and_order_profit(seeded_db):
    """导出统一入口：monthly-pnl / business-pnl / order-profit 三个分支。"""
    monthly = report_for_export(seeded_db, "monthly-pnl", user=None)
    assert "items" in monthly
    business = report_for_export(seeded_db, "business-pnl", user=None)
    assert "items" in business
    profit = report_for_export(seeded_db, "order-profit", user=None)
    assert "items" in profit


def test_router_business_pnl_endpoint(seeded_db):
    out = business_pnl(db=seeded_db, user=None, from_date=None, to_date=None)
    assert "items" in out
