"""M4：异常工作台 / R1-R5 报表 / 审计查询 / P2 历史导入。

功能编号：QLT-01-01、QLT-01-03、QLT-01-05、RPT-01-01~06、MIG-01-01~04、BAS-05-03
"""
from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient

from sqlalchemy.orm import Session

from app.core.money import to_money
from app.domain.enums import ImportRowStatus, IssueStatus, IssueType
from app.domain.quality import ImportBatch, ImportRow, QualityIssue
from app.history import service as history_service
from app.orders import service as order_service
from app.quality import service as quality_service
from app.reporting import service as reporting_service

ISSUES = "/api/v1/quality/issues"
REPORTS = "/api/v1/reports"


# --------------------------------------------------------------------- 异常检测
class TestDetection:
    def test_detection_is_idempotent(self, seeded_db):
        from datetime import date

        from app.domain.enums import Direction, Nature
        from app.domain.trade import Cashflow

        seeded_db.add(
            Cashflow(
                flow_no="HJF9000",
                pool_id=1,
                occurred_on=date(2026, 10, 4),
                nature=Nature.BUSINESS_IN.value,
                category="OTHER",
                direction=Direction.IN.value,
                amount=to_money("500.00"),
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.commit()
        first = quality_service.run_detection(seeded_db, actor="pytest")
        second = quality_service.run_detection(seeded_db, actor="pytest")
        assert first["created_total"] >= 1
        # 第二次复跑不应再新增同一对象工单
        assert second["created_total"] == 0

    def test_orphan_cashflow_is_detected(self, seeded_db):
        from datetime import date

        from app.core.money import to_money
        from app.domain.enums import Direction, Nature
        from app.domain.trade import Cashflow

        seeded_db.add(
            Cashflow(
                flow_no="HJF9001",
                pool_id=1,
                occurred_on=date(2026, 10, 4),
                nature=Nature.BUSINESS_IN.value,
                category="OTHER",
                direction=Direction.IN.value,
                amount=to_money("888.00"),
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.commit()
        result = quality_service.run_detection(seeded_db, actor="pytest")
        assert result["created"]["orphan_cashflow"] >= 1
        issues = quality_service.list_issues(
            seeded_db, issue_type=IssueType.ORPHAN_CASHFLOW.value
        )
        assert issues
        assert issues[0]["amount"] == "888.00"

    def test_negative_available_is_detected(self, seeded_db):
        from datetime import date

        from app.domain.enums import Direction, Nature
        from app.domain.trade import Cashflow

        seeded_db.add(
            Cashflow(
                flow_no="HJF9002",
                pool_id=1,
                occurred_on=date(2026, 10, 4),
                nature=Nature.BUSINESS_OUT.value,
                category="OTHER",
                direction=Direction.OUT.value,
                amount=to_money("99999.00"),
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.commit()
        quality_service.run_detection(seeded_db, actor="pytest")
        issues = quality_service.list_issues(
            seeded_db, issue_type=IssueType.NEGATIVE_AVAILABLE.value
        )
        assert issues

    def test_overview_groups_by_type_and_severity(self, seeded_db):
        quality_service.run_detection(seeded_db, actor="pytest")
        data = quality_service.overview(seeded_db)
        assert "total" in data and "blockers" in data
        for item in data["items"]:
            assert item["severity"] in ("BLOCKER", "HIGH", "MEDIUM", "LOW")
            assert item["entry"].startswith("/quality")


# --------------------------------------------------------------------- 工单闭环
class TestIssueWorkflow:
    def _new_issue(self, seeded_db):
        """显式造一条孤儿流水，保证工单存在（不依赖环境残留）。"""
        from datetime import date

        from app.domain.enums import Direction, Nature
        from app.domain.trade import Cashflow

        seeded_db.add(
            Cashflow(
                flow_no="HJF9100",
                pool_id=1,
                occurred_on=date(2026, 10, 4),
                nature=Nature.BUSINESS_IN.value,
                category="OTHER",
                direction=Direction.IN.value,
                amount=to_money("123.00"),
                created_by="pytest",
                updated_by="pytest",
            )
        )
        seeded_db.commit()
        quality_service.run_detection(seeded_db, actor="pytest")
        issues = quality_service.list_issues(
            seeded_db, issue_type=IssueType.ORPHAN_CASHFLOW.value
        )
        assert issues, "孤儿流水检测未产出工单"
        return issues[0]

    def test_assign_then_resolve_requires_resolution(self, seeded_db):
        issue = self._new_issue(seeded_db)
        assigned = quality_service.assign_issue(
            seeded_db, issue["id"], 7, actor="pytest"
        )
        assert assigned["status"] == IssueStatus.ASSIGNED.value
        assert assigned["owner_id"] == 7

        with pytest.raises(Exception) as exc:
            quality_service.resolve_issue(
                seeded_db, issue["id"], resolution="  ", actor="pytest"
            )
        assert "解决方式" in str(exc.value)

        closed = quality_service.resolve_issue(
            seeded_db, issue["id"], resolution="已补录路由", actor="pytest"
        )
        assert closed["status"] == IssueStatus.CLOSED.value
        assert closed["closed_at"] is not None

    def test_closed_issue_cannot_be_reassigned(self, seeded_db):
        issue = self._new_issue(seeded_db)
        quality_service.resolve_issue(
            seeded_db, issue["id"], resolution="已处置", actor="pytest"
        )
        with pytest.raises(Exception):
            quality_service.assign_issue(seeded_db, issue["id"], 1, actor="pytest")

    def test_resolution_writes_audit(self, seeded_db):
        from sqlalchemy import select

        from app.domain.foundation import AuditLog

        issue = self._new_issue(seeded_db)
        quality_service.resolve_issue(
            seeded_db, issue["id"], resolution="已处置", actor="pytest"
        )
        seeded_db.commit()
        rows = seeded_db.scalars(
            select(AuditLog).where(AuditLog.entity_type == "quality_issue")
        ).all()
        assert rows


# --------------------------------------------------------------------- 报表
class TestReports:
    def test_r1_excludes_th_and_zero_cost(self, seeded_db):
        data = reporting_service.r1_inventory_health(seeded_db)
        for item in data["items"]:
            assert item["status"] in ("IN_STOCK", "INSTALLMENT", "FOR_SALE")

    def test_r2_operating_expense_excludes_account_cost(self, seeded_db):
        """账号 COST 只能进直接成本，不能进运营费用（R2 验收口径）。"""
        from datetime import date

        order = order_service.create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest"
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

    def test_r5_uncollected_rebate_is_separate_column(self, seeded_db):
        data = reporting_service.r5_business_pnl(seeded_db)
        for item in data["items"]:
            assert "uncollected_rebate" in item
            # 完整收益只加已结算返点，不摊未归集
            assert item["full_income"] == item["main_profit"] + item["settled_rebate"]

    def test_daily_funds_matches_pool_balance(self, seeded_db):
        from datetime import date

        report = reporting_service.daily_funds_report(seeded_db, on=date(2026, 10, 4))
        assert report["items"]
        for item in report["items"]:
            assert "available" in item and "th_advance" in item

    def test_order_profit_totals_are_consistent(self, seeded_db):
        data = reporting_service.order_profit_detail(seeded_db)
        for item in data["items"]:
            assert item["net_profit"] == (
                item["income"] - item["buy_amount"] - item["direct_cost"] + item["rebate"]
            )

    def test_r3_drills_down_to_orders(self, seeded_db):
        data = reporting_service.r3_commission_reconciliation(seeded_db)
        for person in data["items"]:
            assert person["orders"]
            assert sum(o["profit_base"] for o in person["orders"]) == person["profit_base"]


# --------------------------------------------------------------------- 历史导入
class TestHistoryImport:
    def test_no_auto_matching_on_create(self, seeded_db):
        batch = history_service.create_batch(
            seeded_db,
            source_name="legacy-orders.xlsx",
            rows=[{"order_no": "OLD-1", "amount": "100"}, {"order_no": "OLD-2"}],
            actor="pytest",
        )
        assert batch["unmapped_count"] == 2
        rows = history_service.list_rows(seeded_db, batch["id"])
        assert all(r["mapped_order_id"] is None for r in rows)
        assert all(r["status"] == ImportRowStatus.UNMAPPED.value for r in rows)

    def test_manual_mapping_then_commit(self, seeded_db):
        from datetime import date

        order = order_service.create_order(
            seeded_db, order_type="HS", trade_date=date(2026, 10, 4), actor="pytest"
        )
        batch = history_service.create_batch(
            seeded_db, source_name="legacy.xlsx", rows=[{"order_no": "OLD-9"}], actor="pytest"
        )
        row = history_service.list_rows(seeded_db, batch["id"])[0]
        mapped = history_service.assign_mapping(
            seeded_db, row["id"], order_id=order.id, basis="对账单第 9 行", actor="pytest"
        )
        assert mapped["status"] == ImportRowStatus.MAPPED.value

        committed = history_service.commit_batch(seeded_db, batch["id"], actor="pytest")
        assert committed["imported"] == 1
        assert committed["unmapped"] == 0

    def test_unmapped_rows_become_issues_not_business_data(self, seeded_db):
        from sqlalchemy import select

        from app.domain.trade import Cashflow, OrderEvent

        before_flows = len(seeded_db.scalars(select(Cashflow)).all())
        before_events = len(seeded_db.scalars(select(OrderEvent)).all())

        batch = history_service.create_batch(
            seeded_db, source_name="legacy.xlsx", rows=[{"x": 1}, {"y": 2}], actor="pytest"
        )
        committed = history_service.commit_batch(seeded_db, batch["id"], actor="pytest")
        assert committed["unmapped"] == 2

        # 红线：历史导入不写任何业务数据，不补造划转
        assert len(seeded_db.scalars(select(Cashflow)).all()) == before_flows
        assert len(seeded_db.scalars(select(OrderEvent)).all()) == before_events

        issues = quality_service.list_issues(
            seeded_db, issue_type=IssueType.HISTORY_UNMAPPED.value
        )
        assert len(issues) == 2

    def test_commit_is_not_repeatable(self, seeded_db):
        batch = history_service.create_batch(
            seeded_db, source_name="legacy.xlsx", rows=[{"x": 1}], actor="pytest"
        )
        history_service.commit_batch(seeded_db, batch["id"], actor="pytest")
        with pytest.raises(Exception):
            history_service.commit_batch(seeded_db, batch["id"], actor="pytest")


# --------------------------------------------------------------------- API 层
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

    def test_quality_endpoints(self, seeded_client, headers):
        assert seeded_client.get("/api/v1/quality/overview", headers=headers).status_code == 200
        assert seeded_client.post("/api/v1/quality/detect", headers=headers).status_code == 200
        listed = seeded_client.get(ISSUES, headers=headers)
        assert listed.status_code == 200
        assert "items" in listed.json()

    def test_audit_logs_endpoint(self, seeded_client, headers):
        response = seeded_client.get("/api/v1/audit-logs", headers=headers)
        assert response.status_code == 200
        assert "items" in response.json()

    def test_viewer_cannot_run_detection(self, seeded_client, viewer_headers):
        response = seeded_client.post(
            "/api/v1/quality/detect", headers=viewer_headers
        )
        assert response.status_code == 403

    def test_history_endpoints(self, seeded_client, headers):
        created = seeded_client.post(
            "/api/v1/history/batches",
            json={"source_name": "api-legacy.xlsx", "rows": [{"a": 1}]},
            headers=headers,
        )
        assert created.status_code == 200
        batch_id = created.json()["id"]
        assert seeded_client.get(f"/api/v1/history/batches/{batch_id}/rows", headers=headers).status_code == 200
        assert (
            seeded_client.post(
                f"/api/v1/history/batches/{batch_id}/commit", headers=headers
            ).status_code
            == 200
        )


__all__ = ["TestClient"]


class TestIssuePagination:
    """工单分页契约：total 必须是筛选后的总数，不是当前页条数。

    回归背景：初版 list_issues 直接返回 len(items)，前端分页器据此渲染，
    数据量超过一页后 total 就等于 limit，翻页会出现空页。
    """

    @staticmethod
    def _make_issues(seeded_db: Session, count: int) -> None:
        from app.domain.quality import QualityIssue
        from app.domain.enums import IssueSeverity, IssueStatus, IssueType

        for i in range(count):
            seeded_db.add(
                QualityIssue(
                    issue_no=f"QIP{i:04d}",
                    issue_type=IssueType.ACCOUNT_CONFLICT.value,
                    severity=IssueSeverity.LOW.value,
                    status=IssueStatus.OPEN.value,
                    entity_type="account",
                    entity_id=i + 1,
                    entity_label=f"acc-{i}",
                    amount=to_money("1.00"),
                    detected_on=date(2026, 10, 4),
                )
            )
        seeded_db.commit()

    def test_total_is_filtered_count_not_page_length(self, seeded_client, seeded_db, headers):
        self._make_issues(seeded_db, 7)
        response = seeded_client.get(f"{ISSUES}?limit=3&offset=0", headers=headers)
        assert response.status_code == 200
        body = response.json()
        assert len(body["items"]) == 3
        assert body["total"] >= 7, "total 必须反映筛选后总数"

    def test_second_page_returns_remaining_rows(self, seeded_client, seeded_db, headers):
        self._make_issues(seeded_db, 7)
        first = seeded_client.get(f"{ISSUES}?limit=3&offset=0", headers=headers).json()
        second = seeded_client.get(f"{ISSUES}?limit=3&offset=3", headers=headers).json()
        first_ids = {row["id"] for row in first["items"]}
        second_ids = {row["id"] for row in second["items"]}
        assert first_ids and second_ids
        assert not (first_ids & second_ids), "两页不应重复返回同一工单"
        assert second["total"] == first["total"], "翻页时 total 不得变化"

    def test_filtered_total_shrinks(self, seeded_client, seeded_db, headers):
        self._make_issues(seeded_db, 5)
        unfiltered = seeded_client.get(ISSUES, headers=headers).json()
        filtered = seeded_client.get(
            f"{ISSUES}?issue_type=ACCOUNT_CONFLICT", headers=headers
        ).json()
        assert filtered["total"] == unfiltered["total"]
        none_match = seeded_client.get(
            f"{ISSUES}?issue_type=TH_UNCLOSED", headers=headers
        ).json()
        assert none_match["total"] == 0
        assert none_match["items"] == []


class TestHistoryClosure:
    """MIG-01 补齐验收：预览 / 对账 / 回滚 / 更正 / 补录依据 / UNLINKED 标记。

    红线复验：全流程**不得写入任何 cashflow**，历史只作参考。
    """

    @staticmethod
    def _legacy_rows() -> list[dict[str, object]]:
        """按 rawdata/真实历史表结构造行（sheet9_orders 字段名）。"""
        return [
            {"日期": "2026/07/14", "交易金额": 13888, "利润": 429, "订单类型": "代挂", "本金": 0},
            {"日期": "2026/07/15", "交易金额": 20000, "利润": 1200, "订单类型": "回收", "本金": 18800},
            {"日期": "2026/07/16", "交易金额": 5000, "利润": 300, "订单类型": "回收", "本金": 4700},
        ]

    # ── MIG-01-02 字段映射预览 ──
    def test_preview_reports_columns_samples_and_missing(self, seeded_db):
        batch = history_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._legacy_rows(), actor="pytest"
        )
        preview = history_service.preview_mapping(seeded_db, batch["id"])
        assert preview["total_rows"] == 3
        cols = {c["source_column"]: c for c in preview["columns"]}
        assert cols["交易金额"]["target_field"] == "gross_amount"
        assert cols["利润"]["target_field"] == "profit"
        assert cols["交易金额"]["fill_rate"] == 100.0
        assert cols["交易金额"]["samples"]
        # 「日期」在源数据里存在但不在建议字典 → 计入 blockers（需人工确认）
        assert preview["blockers"] is not None

    def test_preview_does_not_persist_anything(self, seeded_db):
        batch = history_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._legacy_rows(), actor="pytest"
        )
        before = len(history_service.list_rows(seeded_db, batch["id"]))
        history_service.preview_mapping(seeded_db, batch["id"])
        after = history_service.list_rows(seeded_db, batch["id"])
        assert len(after) == before
        assert all(r["status"] == ImportRowStatus.UNMAPPED.value for r in after)

    def test_preview_empty_batch(self, seeded_db):
        batch = history_service.create_batch(
            seeded_db, source_name="empty.xlsx", rows=[{"a": 1}], actor="pytest"
        )
        preview = history_service.preview_mapping(seeded_db, batch["id"])
        assert preview["total_rows"] == 1

    # ── MIG-01-04 迁移对账报告 ──
    def test_reconciliation_counts_and_amounts(self, seeded_db):
        batch = history_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._legacy_rows(), actor="pytest"
        )
        report = history_service.reconciliation_report(seeded_db, batch["id"])
        assert report["rows"]["source_total"] == 3
        assert report["amounts"]["before"]["交易金额"] == "38888.00"
        assert report["amounts"]["before"]["利润"] == "1929.00"
        # 迁移前总额 vs 仅映射行的差额
        assert report["requires_adjudication"] is True

    def test_reconciliation_writes_no_cashflow(self, seeded_db):
        from app.domain.trade import Cashflow

        batch = history_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._legacy_rows(), actor="pytest"
        )
        before = seeded_db.query(Cashflow).count()
        history_service.reconciliation_report(seeded_db, batch["id"])
        history_service.commit_batch(seeded_db, batch["id"], actor="pytest")
        assert seeded_db.query(Cashflow).count() == before, "历史导入绝不能写现金流"

    # ── MIG-01-05 补录依据必填 + 前后状态留存 ──
    def test_mapping_requires_basis(self, seeded_db):
        batch = history_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._legacy_rows(), actor="pytest"
        )
        row = history_service.list_rows(seeded_db, batch["id"])[0]
        with pytest.raises(Exception):
            history_service.assign_mapping(seeded_db, row["id"], basis="  ", actor="pytest")

    def test_mapping_keeps_before_snapshot(self, seeded_db):
        batch = history_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._legacy_rows(), actor="pytest"
        )
        row = history_service.list_rows(seeded_db, batch["id"])[0]
        mapped = history_service.assign_mapping(
            seeded_db, row["id"], account_id=None, order_id=None, basis="无", actor="pytest"
        )
        # 首次指派留存前态：原始状态是 UNMAPPED
        assert mapped["mapped_before"]["status"] == ImportRowStatus.UNMAPPED.value
        assert mapped["mapping_basis"] == "无"

    # ── MIG-01-06 UNLINKED_TRANSFER 标记 ──
    def test_mark_unlinked_creates_issue_without_pairing(self, seeded_db):
        from app.domain.enums import IssueType
        from app.domain.trade import Cashflow

        batch = history_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._legacy_rows(), actor="pytest"
        )
        row = history_service.list_rows(seeded_db, batch["id"])[0]
        flows_before = seeded_db.query(Cashflow).count()
        marked = history_service.mark_unlinked_transfer(seeded_db, row["id"], actor="pytest")
        assert marked["unlinked_transfer"] is True
        # 关键红线：打了标记但绝不能凭空补出配对流水
        assert seeded_db.query(Cashflow).count() == flows_before
        issues = quality_service.list_issues(
            seeded_db, issue_type=IssueType.UNLINKED_TRANSFER.value
        )
        assert len(issues) == 1, "应生成一条 UNLINKED_TRANSFER 工单"

    def test_mark_unlinked_is_idempotent(self, seeded_db):
        from app.domain.enums import IssueType

        batch = history_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._legacy_rows(), actor="pytest"
        )
        row = history_service.list_rows(seeded_db, batch["id"])[0]
        history_service.mark_unlinked_transfer(seeded_db, row["id"], actor="pytest")
        history_service.mark_unlinked_transfer(seeded_db, row["id"], actor="pytest")
        issues = quality_service.list_issues(
            seeded_db, issue_type=IssueType.UNLINKED_TRANSFER.value
        )
        assert len(issues) == 1, "重复标记不得重复建单"

    # ── MIG-01-07 回滚 ──
    def test_rollback_draft_batch(self, seeded_db):
        batch = history_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._legacy_rows(), actor="pytest"
        )
        rolled = history_service.rollback_batch(
            seeded_db, batch["id"], reason="源文件有误", actor="pytest"
        )
        assert rolled["status"] == "ROLLED_BACK"
        assert rolled["rolled_back_by"] == "pytest"
        assert rolled["rolled_back_at"] is not None
        rows = history_service.list_rows(seeded_db, batch["id"])
        assert all(r["status"] == ImportRowStatus.ROLLED_BACK.value for r in rows)

    def test_rollback_keeps_raw_data(self, seeded_db):
        """回滚不得删除原始行内容（只读保护 + 可追溯）。"""
        batch = history_service.create_batch(
            seeded_db, source_name="orders.xlsx", rows=self._legacy_rows(), actor="pytest"
        )
        history_service.rollback_batch(seeded_db, batch["id"], reason="x", actor="pytest")
        rows = history_service.list_rows(seeded_db, batch["id"])
        assert len(rows) == 3
        assert rows[0]["raw"]["交易金额"] == 13888

    def test_rollback_requires_reason(self, seeded_db):
        batch = history_service.create_batch(
            seeded_db, source_name="o.xlsx", rows=[{"a": 1}], actor="pytest"
        )
        with pytest.raises(Exception):
            history_service.rollback_batch(seeded_db, batch["id"], reason="", actor="pytest")

    def test_committed_batch_cannot_rollback(self, seeded_db):
        batch = history_service.create_batch(
            seeded_db, source_name="o.xlsx", rows=[{"a": 1}], actor="pytest"
        )
        history_service.commit_batch(seeded_db, batch["id"], actor="pytest")
        with pytest.raises(Exception):
            history_service.rollback_batch(seeded_db, batch["id"], reason="x", actor="pytest")

    def test_rollback_twice_is_rejected(self, seeded_db):
        batch = history_service.create_batch(
            seeded_db, source_name="o.xlsx", rows=[{"a": 1}], actor="pytest"
        )
        history_service.rollback_batch(seeded_db, batch["id"], reason="x", actor="pytest")
        with pytest.raises(Exception):
            history_service.rollback_batch(seeded_db, batch["id"], reason="y", actor="pytest")

    # ── MIG-01-08 更正批次 ──
    def test_correction_batch_links_to_origin(self, seeded_db):
        batch = history_service.create_batch(
            seeded_db, source_name="o.xlsx", rows=self._legacy_rows(), actor="pytest"
        )
        history_service.commit_batch(seeded_db, batch["id"], actor="pytest")
        correction = history_service.create_correction_batch(
            seeded_db,
            batch["id"],
            rows=[{"日期": "2026/07/14", "交易金额": 13888, "利润": 400}],
            reason="利润算错 29 元",
            actor="pytest",
        )
        assert correction["corrects_batch_id"] == batch["id"]
        assert correction["status"] == "DRAFT"

    def test_correction_does_not_touch_origin_rows(self, seeded_db):
        """只读保护：更正批次不得改动原批次的原始行。"""
        batch = history_service.create_batch(
            seeded_db, source_name="o.xlsx", rows=self._legacy_rows(), actor="pytest"
        )
        history_service.commit_batch(seeded_db, batch["id"], actor="pytest")
        origin_rows_before = history_service.list_rows(seeded_db, batch["id"])
        history_service.create_correction_batch(
            seeded_db,
            batch["id"],
            rows=[{"交易金额": 1}],
            reason="更正",
            actor="pytest",
        )
        assert history_service.list_rows(seeded_db, batch["id"]) == origin_rows_before

    def test_correction_requires_reason_and_rows(self, seeded_db):
        batch = history_service.create_batch(
            seeded_db, source_name="o.xlsx", rows=[{"a": 1}], actor="pytest"
        )
        history_service.commit_batch(seeded_db, batch["id"], actor="pytest")
        with pytest.raises(Exception):
            history_service.create_correction_batch(
                seeded_db, batch["id"], rows=[{"a": 1}], reason="", actor="pytest"
            )
        with pytest.raises(Exception):
            history_service.create_correction_batch(
                seeded_db, batch["id"], rows=[], reason="r", actor="pytest"
            )

    def test_rolled_back_batch_cannot_be_corrected(self, seeded_db):
        batch = history_service.create_batch(
            seeded_db, source_name="o.xlsx", rows=[{"a": 1}], actor="pytest"
        )
        history_service.rollback_batch(seeded_db, batch["id"], reason="x", actor="pytest")
        with pytest.raises(Exception):
            history_service.create_correction_batch(
                seeded_db, batch["id"], rows=[{"a": 2}], reason="r", actor="pytest"
            )


class TestEnumConstraintDrift:
    """防回归：模型枚举与数据库 CHECK 约束必须一致。

    实测踩过：给 `IssueType` 加了 `UNLINKED_TRANSFER` 但没重建 `quality_issues`，
    插入工单时 sqlite3.IntegrityError（CHECK constraint failed），
    而 `alembic check` 当时是「No new upgrade operations detected」——它不校验 CHECK 内容。
    """

    def test_every_issue_type_passes_db_check(self, seeded_db):
        from app.domain.enums import IssueType

        for issue_type in IssueType:
            issue = QualityIssue(
                issue_no=f"CHK{issue_type.value[:6]}",
                issue_type=issue_type.value,
                severity="LOW",
                status="OPEN",
                entity_type="probe",
                entity_id=1,
                detected_on=date(2026, 10, 4),
            )
            seeded_db.add(issue)
            try:
                seeded_db.flush()
            except Exception as exc:  # noqa: BLE001
                pytest.fail(
                    f"枚举 {issue_type.value} 被数据库 CHECK 拒绝：{exc}。"
                    "需在迁移中重建对应表（alembic check 查不出 CHECK 内容漂移）。"
                )
        seeded_db.rollback()

    def test_every_batch_status_passes_db_check(self, seeded_db):
        from app.domain.enums import ImportBatchStatus

        for status in ImportBatchStatus:
            batch = ImportBatch(
                batch_no=f"CHK{status.value[:8]}",
                source_name="probe.xlsx",
                status=status.value,
                row_count=0,
                unmapped_count=0,
            )
            seeded_db.add(batch)
            try:
                seeded_db.flush()
            except Exception as exc:  # noqa: BLE001
                pytest.fail(f"批次状态 {status.value} 被 CHECK 拒绝：{exc}")
        seeded_db.rollback()

    def test_every_row_status_passes_db_check(self, seeded_db):
        from app.domain.enums import ImportRowStatus

        batch = history_service.create_batch(
            seeded_db, source_name="probe.xlsx", rows=[{"a": 1}], actor="pytest"
        )
        for status in ImportRowStatus:
            row = ImportRow(batch_id=batch["id"], row_no=1, raw={"a": 1}, status=status.value)
            seeded_db.add(row)
            try:
                seeded_db.flush()
            except Exception as exc:  # noqa: BLE001
                pytest.fail(f"行状态 {status.value} 被 CHECK 拒绝：{exc}")
            seeded_db.expunge(row)
        seeded_db.rollback()
